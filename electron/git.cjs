const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WorkspaceError } = require("./workspace.cjs");

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PATHS_PER_OPERATION = 256;
const MAX_PATH_BYTES = 4_096;
const MAX_PATH_ARGUMENT_BYTES = 128 * 1024;
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_LOG_COUNT = 100;
const MAX_LOG_COUNT = 200;
const MAX_LOG_SKIP = 10_000;
const MAX_REMOTE_COUNT = 128;
const MAX_REMOTE_NAME_BYTES = 255;
const NO_HOOKS_PATH = process.platform === "win32"
  ? path.join(os.tmpdir(), ".trace-disabled-git-hooks")
  : "/dev/null";

const COMMON_GIT_ARGUMENTS = Object.freeze([
  "--no-pager",
  "--literal-pathspecs",
  "-c", "color.ui=false",
  "-c", "core.quotepath=false",
  "-c", "core.pager=cat",
  "-c", `core.hooksPath=${NO_HOOKS_PATH}`,
  "-c", "core.fsmonitor=false",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  "-c", "credential.helper=",
]);

const LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00";
const BRANCH_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(HEAD)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(objectname)",
  "%(committerdate:iso-strict)",
  "%(subject)",
  "%(symref)",
].join("%00") + "%00";

class GitProcessError extends Error {
  constructor(kind) {
    super("The Git process could not be completed.");
    this.name = "GitProcessError";
    this.kind = kind;
  }
}

function safeGitEnvironment(source = process.env) {
  const allowedKeys = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_CTYPE",
    "XDG_CONFIG_HOME",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_AUTHOR_DATE",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "GIT_COMMITTER_DATE",
  ];
  const environment = {};
  for (const key of allowedKeys) {
    if (typeof source[key] === "string") environment[key] = source[key];
  }
  if (!environment.PATH) environment.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  environment.LC_ALL = "C";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_ASKPASS = "";
  environment.SSH_ASKPASS = "";
  environment.GIT_PAGER = "cat";
  environment.PAGER = "cat";
  environment.GIT_EXTERNAL_DIFF = "";
  environment.GIT_NO_LAZY_FETCH = "1";
  return environment;
}

function resolveGitExecutable() {
  const candidates = process.platform === "darwin"
    ? ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]
    : ["/usr/bin/git", "/usr/local/bin/git"];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Try the next trusted absolute installation path.
    }
  }
  return process.platform === "win32" ? "git.exe" : "/usr/bin/git";
}

function createGitProcessRunner({
  execFile = childProcess.execFile,
  gitPath = resolveGitExecutable(),
  environment = process.env,
} = {}) {
  const env = safeGitEnvironment(environment);
  return {
    run({ cwd, args, input, timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
      return new Promise((resolve, reject) => {
        const subprocess = execFile(
          gitPath,
          args,
          {
            cwd,
            env,
            encoding: "utf8",
            timeout: timeoutMs,
            killSignal: "SIGKILL",
            maxBuffer: maxOutputBytes,
            windowsHide: true,
            shell: false,
          },
          (error, stdout = "", stderr = "") => {
            const result = {
              stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
              stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
              exitCode: 0,
              signal: null,
            };
            if (!error) {
              resolve(result);
              return;
            }

            if (typeof error.code === "number") {
              resolve({ ...result, exitCode: error.code, signal: error.signal ?? null });
              return;
            }
            if (["ENOENT", "EACCES", "ENOEXEC"].includes(error.code)) {
              reject(new GitProcessError("unavailable"));
              return;
            }
            if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              reject(new GitProcessError("output-limit"));
              return;
            }
            if (error.killed || error.code === "ETIMEDOUT") {
              reject(new GitProcessError("timeout"));
              return;
            }
            reject(new GitProcessError("failed"));
          },
        );
        if (typeof input === "string" && subprocess?.stdin) {
          subprocess.stdin.on("error", () => {});
          subprocess.stdin.end(input);
        }
      });
    },
  };
}

function invalidGitOutput() {
  return new WorkspaceError("GIT_INVALID_OUTPUT", "Git returned data that Trace could not safely read.");
}

function splitFixedFields(record, fieldCount) {
  const fields = [];
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    const separator = record.indexOf(" ", cursor);
    if (separator === -1) throw invalidGitOutput();
    fields.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }
  fields.push(record.slice(cursor));
  return fields;
}

function validatePortableGitPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) throw invalidGitOutput();

  const normalized = path.posix.normalize(value);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
    throw invalidGitOutput();
  }
  return normalized;
}

function statusFile(recordType, xy, submodule, filePath, originalPath = null) {
  if (!/^[.MADRCUT?!]{2}$/.test(xy)) throw invalidGitOutput();
  const conflict = recordType === "unmerged" || ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(xy);
  const untracked = recordType === "untracked";
  const ignored = recordType === "ignored";
  const indexStatus = untracked || ignored ? xy[0] : xy[0] === "." ? null : xy[0];
  const worktreeStatus = untracked || ignored ? xy[1] : xy[1] === "." ? null : xy[1];
  return {
    path: validatePortableGitPath(filePath),
    originalPath: originalPath === null ? null : validatePortableGitPath(originalPath),
    recordType,
    indexStatus,
    worktreeStatus,
    staged: !untracked && !ignored && xy[0] !== ".",
    modified: !untracked && !ignored && xy[1] !== ".",
    untracked,
    ignored,
    conflict,
    submodule: submodule === "N..." ? null : submodule,
  };
}

function parsePorcelainV2(output) {
  if (typeof output !== "string") throw invalidGitOutput();
  const branch = {
    current: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false,
  };
  const files = [];
  const records = output.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# ")) {
      const separator = record.indexOf(" ", 2);
      if (separator === -1) continue;
      const key = record.slice(2, separator);
      const value = record.slice(separator + 1);
      if (key === "branch.oid") {
        branch.unborn = value === "(initial)";
        branch.oid = branch.unborn ? null : value;
      } else if (key === "branch.head") {
        branch.detached = value === "(detached)";
        branch.current = branch.detached ? null : value;
      } else if (key === "branch.upstream") {
        branch.upstream = value;
      } else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (!match) throw invalidGitOutput();
        branch.ahead = Number.parseInt(match[1], 10);
        branch.behind = Number.parseInt(match[2], 10);
      }
      continue;
    }

    if (record.startsWith("1 ")) {
      const fields = splitFixedFields(record, 8);
      files.push(statusFile("ordinary", fields[1], fields[2], fields[8]));
      continue;
    }
    if (record.startsWith("2 ")) {
      const fields = splitFixedFields(record, 9);
      const originalPath = records[index + 1];
      if (!originalPath) throw invalidGitOutput();
      index += 1;
      files.push(statusFile("renamed", fields[1], fields[2], fields[9], originalPath));
      continue;
    }
    if (record.startsWith("u ")) {
      const fields = splitFixedFields(record, 10);
      files.push(statusFile("unmerged", fields[1], fields[2], fields[10]));
      continue;
    }
    if (record.startsWith("? ")) {
      files.push(statusFile("untracked", "??", null, record.slice(2)));
      continue;
    }
    if (record.startsWith("! ")) {
      files.push(statusFile("ignored", "!!", null, record.slice(2)));
      continue;
    }
    throw invalidGitOutput();
  }

  if (branch.oid !== null && !/^[0-9a-f]{40,64}$/i.test(branch.oid)) throw invalidGitOutput();
  const counts = {
    total: files.length,
    staged: files.filter((file) => file.staged).length,
    modified: files.filter((file) => file.modified).length,
    untracked: files.filter((file) => file.untracked).length,
    conflicts: files.filter((file) => file.conflict).length,
  };
  return { branch, files, counts };
}

function parseTracking(value) {
  const tracking = { ahead: 0, behind: 0, gone: value === "[gone]" };
  const ahead = /\bahead (\d+)/.exec(value);
  const behind = /\bbehind (\d+)/.exec(value);
  if (ahead) tracking.ahead = Number.parseInt(ahead[1], 10);
  if (behind) tracking.behind = Number.parseInt(behind[1], 10);
  return tracking;
}

function parseBranchRefs(output) {
  if (typeof output !== "string") throw invalidGitOutput();
  const branches = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    const fields = rawLine.split("\0");
    if (fields.at(-1) === "") fields.pop();
    if (fields.length !== 9) throw invalidGitOutput();
    const [ref, name, head, upstream, track, hash, date, subject, symref] = fields;
    if (symref) continue;
    const kind = ref.startsWith("refs/heads/")
      ? "local"
      : ref.startsWith("refs/remotes/")
        ? "remote"
        : null;
    if (!kind || !name || /[\0-\x1f\x7f]/.test(name) || !/^[0-9a-f]{40,64}$/i.test(hash)) {
      throw invalidGitOutput();
    }
    const tracking = parseTracking(track);
    branches.push({
      kind,
      name,
      ref,
      current: kind === "local" && head.trim() === "*",
      upstream: upstream || null,
      ahead: tracking.ahead,
      behind: tracking.behind,
      upstreamGone: tracking.gone,
      hash,
      date: date || null,
      subject,
    });
  }
  return branches;
}

function parseLog(output) {
  if (typeof output !== "string") throw invalidGitOutput();
  if (output.length === 0) return [];
  const commits = [];
  const fields = output.split("\0");
  let cursor = 0;
  while (cursor < fields.length) {
    while (fields[cursor] === "" && cursor === fields.length - 1) cursor += 1;
    if (cursor >= fields.length) break;
    if (cursor + 6 >= fields.length) throw invalidGitOutput();
    const hash = fields[cursor].replace(/^\r?\n/, "");
    const parentList = fields[cursor + 1];
    const authorName = fields[cursor + 2];
    const authorEmail = fields[cursor + 3];
    const date = fields[cursor + 4];
    const subject = fields[cursor + 5];
    const recordSeparator = fields[cursor + 6];
    if (recordSeparator !== "") throw invalidGitOutput();
    cursor += 7;
    if (!/^[0-9a-f]{40,64}$/i.test(hash)) throw invalidGitOutput();
    const parents = parentList ? parentList.split(" ") : [];
    if (parents.some((parent) => !/^[0-9a-f]{40,64}$/i.test(parent))) throw invalidGitOutput();
    commits.push({
      hash,
      parents,
      author: { name: authorName, email: authorEmail },
      date,
      subject,
    });
  }
  return commits;
}

function requestObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceError("INVALID_REQUEST", "The Git request is invalid.");
  }
  return value;
}

function boundedInteger(value, { minimum, maximum, fallback, label }) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new WorkspaceError("INVALID_REQUEST", `The Git ${label} is invalid.`);
  }
  return value;
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function workspacePath(value, rootPath) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new WorkspaceError("INVALID_PATH", "A valid workspace-relative Git path is required.");
  }
  const normalized = path.normalize(value);
  const absolutePath = path.resolve(rootPath, normalized);
  if (normalized === "." || !isWithin(rootPath, absolutePath)) {
    throw new WorkspaceError("OUTSIDE_WORKSPACE", "The Git path is outside the current workspace.");
  }
  return normalized.split(path.sep).join("/");
}

function workspacePaths(value, rootPath) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS_PER_OPERATION) {
    throw new WorkspaceError("INVALID_REQUEST", "Select one or more workspace files.");
  }
  const paths = [...new Set(value.map((item) => workspacePath(item, rootPath)))];
  const argumentBytes = paths.reduce((total, item) => total + Buffer.byteLength(item, "utf8") + 1, 0);
  if (argumentBytes > MAX_PATH_ARGUMENT_BYTES) {
    throw new WorkspaceError("INVALID_REQUEST", "The selected file paths are too large for one Git operation.");
  }
  return paths;
}

function branchName(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 255 ||
    /[\0-\x20\x7f]/.test(value) ||
    value.startsWith("-") ||
    value === "@" ||
    value.startsWith("refs/") ||
    value.includes("@{")
  ) {
    throw new WorkspaceError("INVALID_BRANCH", "Enter a valid local branch name.");
  }
  return value;
}

function commitHash(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new WorkspaceError("INVALID_COMMIT", "Select a valid commit.");
  }
  return value;
}

function commitMessage(value) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_COMMIT_MESSAGE_BYTES
  ) {
    throw new WorkspaceError("INVALID_COMMIT_MESSAGE", "Enter a commit message under 64 KB.");
  }
  return value;
}

function notRepositoryError() {
  return new WorkspaceError("NOT_A_REPOSITORY", "The open workspace is not a Git repository root.");
}

function failureText(result) {
  return `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
}

function githubPath(owner, repository) {
  const cleanRepository = repository.toLowerCase().endsWith(".git")
    ? repository.slice(0, -4)
    : repository;
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(cleanRepository)
  ) return null;
  return {
    provider: "github",
    host: "github.com",
    owner,
    repository: cleanRepository,
    fullName: `${owner}/${cleanRepository}`,
  };
}

function parseGitHubRemoteUrl(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) return null;

  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(value);
  if (scp) return githubPath(scp[1], scp[2]);

  let remote;
  try {
    remote = new URL(value);
  } catch {
    return null;
  }
  if (
    remote.hostname.toLowerCase() !== "github.com" ||
    remote.search ||
    remote.hash ||
    (remote.protocol !== "https:" && remote.protocol !== "ssh:") ||
    (remote.protocol === "https:" && (remote.username || remote.password || remote.port)) ||
    (remote.protocol === "ssh:" && (
      remote.password ||
      (remote.username && remote.username !== "git") ||
      (remote.port && remote.port !== "22")
    ))
  ) return null;
  const segments = remote.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  return githubPath(segments[0], segments[1]);
}

function validRemoteName(value) {
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= MAX_REMOTE_NAME_BYTES &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function opaqueRepositoryKey(rootPath, commonDir) {
  return crypto.createHash("sha256").update(rootPath).update("\0").update(commonDir).digest("hex");
}

class GitManager {
  #workspaceManager;
  #runner;
  #realpath;
  #mutationTail = Promise.resolve();

  constructor({ workspaceManager, runner = createGitProcessRunner(), realpath = fsp.realpath } = {}) {
    if (!workspaceManager || typeof workspaceManager.getExecutionContext !== "function") {
      throw new TypeError("GitManager requires a WorkspaceManager.");
    }
    if (!(typeof runner === "function" || typeof runner?.run === "function")) {
      throw new TypeError("GitManager requires a process runner.");
    }
    this.#workspaceManager = workspaceManager;
    this.#runner = runner;
    this.#realpath = realpath;
  }

  whenIdle() {
    return this.#mutationTail.catch(() => undefined);
  }

  async getRepositorySummary(request = {}) {
    const repository = await this.#repository(request);
    const status = await this.#readStatus(repository);
    const branches = await this.#readBranches(repository, status.branch);
    return {
      workspaceId: repository.workspaceId,
      repositoryId: repository.repositoryId,
      repositoryRoot: "",
      head: status.branch.oid,
      status,
      branches,
    };
  }

  async getRepositoryIdentity(request = {}) {
    const repository = await this.#repository(request);
    const status = await this.#readStatus(repository);
    const namesResult = await this.#run(repository, ["remote"]);
    const names = [];
    const seen = new Set();
    for (const rawName of namesResult.stdout.split("\n")) {
      const name = rawName.endsWith("\r") ? rawName.slice(0, -1) : rawName;
      if (!name || seen.has(name) || !validRemoteName(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length > MAX_REMOTE_COUNT) {
        throw new WorkspaceError("GIT_OUTPUT_LIMIT", "The repository has too many remotes to inspect safely.");
      }
    }

    const remotes = [];
    for (const name of names) {
      const urls = await this.#run(repository, ["remote", "get-url", "--all", name], {
        acceptedExitCodes: [2, 128],
      });
      if (urls.exitCode !== 0) continue;
      const parsed = urls.stdout
        .split("\n")
        .map((url) => url.endsWith("\r") ? url.slice(0, -1) : url)
        .map(parseGitHubRemoteUrl)
        .find(Boolean);
      if (parsed) remotes.push({ name, ...parsed });
    }

    const upstreamRemote = status.branch.upstream
      ? remotes
        .map((remote) => remote.name)
        .sort((left, right) => right.length - left.length)
        .find((name) => status.branch.upstream === name || status.branch.upstream.startsWith(`${name}/`)) ?? null
      : null;

    return {
      workspaceId: repository.workspaceId,
      localRepositoryKey: repository.repositoryId,
      headOid: status.branch.oid,
      currentBranch: status.branch.current,
      upstreamRemote,
      remotes,
    };
  }

  async getGitHubRepository(request = {}) {
    const identity = await this.getRepositoryIdentity(request);
    let selected = identity.upstreamRemote
      ? identity.remotes.find((remote) => remote.name === identity.upstreamRemote)
      : null;
    selected ??= identity.remotes.find((remote) => remote.name === "origin") ?? null;
    if (!selected && identity.remotes.length === 1) selected = identity.remotes[0];
    if (!selected) {
      const code = identity.remotes.length === 0 ? "NO_GITHUB_REMOTE" : "AMBIGUOUS_GITHUB_REMOTE";
      const message = identity.remotes.length === 0
        ? "Add a GitHub remote to connect this repository."
        : "Choose which GitHub remote this workspace should use.";
      throw new WorkspaceError(code, message);
    }
    return {
      workspaceId: identity.workspaceId,
      localRepositoryKey: identity.localRepositoryKey,
      headOid: identity.headOid,
      currentBranch: identity.currentBranch,
      remoteName: selected.name,
      provider: selected.provider,
      host: selected.host,
      owner: selected.owner,
      repository: selected.repository,
      fullName: selected.fullName,
    };
  }

  async getStatus(request = {}) {
    const repository = await this.#repository(request);
    return this.#readStatus(repository);
  }

  async getBranches(request = {}) {
    const repository = await this.#repository(request);
    const status = await this.#readStatus(repository);
    return this.#readBranches(repository, status.branch);
  }

  async getLog(request = {}) {
    const input = requestObject(request);
    const maxCount = boundedInteger(input.maxCount, {
      minimum: 1,
      maximum: MAX_LOG_COUNT,
      fallback: DEFAULT_LOG_COUNT,
      label: "history limit",
    });
    const skip = boundedInteger(input.skip, {
      minimum: 0,
      maximum: MAX_LOG_SKIP,
      fallback: 0,
      label: "history offset",
    });
    const repository = await this.#repository(input);
    const result = await this.#run(repository, [
      "log",
      "--all",
      "--topo-order",
      "-z",
      `--format=${LOG_FORMAT}`,
      `--max-count=${maxCount + 1}`,
      `--skip=${skip}`,
    ]);
    const parsed = parseLog(result.stdout);
    return {
      commits: parsed.slice(0, maxCount),
      maxCount,
      skip,
      hasMore: parsed.length > maxCount,
    };
  }

  async getFileDiff(request = {}) {
    const input = requestObject(request);
    const repository = await this.#repository(input);
    const relativePath = workspacePath(input.path, repository.rootPath);
    const mode = input.mode ?? "working";
    let args;
    let selectedCommit = null;
    let acceptedExitCodes = [];
    if (mode === "working") {
      const status = await this.#readStatus(repository);
      const file = status.files.find((item) => item.path === relativePath);
      if (file?.untracked) {
        args = [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--unified=3",
          "--",
          "/dev/null",
          relativePath,
        ];
        acceptedExitCodes = [1];
      } else {
        const paths = file?.originalPath ? [file.originalPath, relativePath] : [relativePath];
        args = ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--", ...paths];
      }
    } else if (mode === "staged") {
      const status = await this.#readStatus(repository);
      const file = status.files.find((item) => item.path === relativePath);
      const paths = file?.originalPath ? [file.originalPath, relativePath] : [relativePath];
      args = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3", "--", ...paths];
    } else if (mode === "commit") {
      selectedCommit = commitHash(input.commit);
      args = [
        "show",
        "--format=",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        selectedCommit,
        "--",
        relativePath,
      ];
    } else {
      throw new WorkspaceError("INVALID_REQUEST", "Select a working, staged, or commit diff.");
    }
    const result = await this.#run(repository, args, {
      maxOutputBytes: DIFF_MAX_OUTPUT_BYTES,
      acceptedExitCodes,
    });
    return { path: relativePath, mode, commit: selectedCommit, patch: result.stdout };
  }

  async stage(request = {}) {
    return this.#queueMutation(async () => {
      const input = requestObject(request);
      const repository = await this.#repository(input);
      const paths = workspacePaths(input.paths, repository.rootPath);
      await this.#run(repository, ["add", "--all", "--", ...paths]);
      return { applied: true, paths, ...await this.#refreshReceipt(repository) };
    });
  }

  async unstage(request = {}) {
    return this.#queueMutation(async () => {
      const input = requestObject(request);
      const repository = await this.#repository(input);
      const paths = workspacePaths(input.paths, repository.rootPath);
      await this.#run(repository, ["reset", "--quiet", "--", ...paths]);
      return { applied: true, paths, ...await this.#refreshReceipt(repository) };
    });
  }

  async commit(request = {}) {
    return this.#queueMutation(async () => {
      const input = requestObject(request);
      const message = commitMessage(input.message);
      const repository = await this.#repository(input);
      await this.#run(repository, ["commit", "--no-verify", "--quiet", "--file=-"], {
        input: message,
        mapFailure: (result) => {
          const text = failureText(result);
          if (text.includes("nothing to commit") || text.includes("no changes added to commit")) {
            return new WorkspaceError("NOTHING_TO_COMMIT", "There are no staged changes to commit.");
          }
          if (text.includes("author identity unknown") || text.includes("please tell me who you are")) {
            return new WorkspaceError("GIT_IDENTITY_REQUIRED", "Configure a Git name and email before committing.");
          }
          return new WorkspaceError("COMMIT_FAILED", "Git could not create the commit.");
        },
      });
      let commit = null;
      let metadataError = null;
      try {
        const committed = await this.#run(repository, [
          "log",
          "-z",
          `--format=${LOG_FORMAT}`,
          "--max-count=1",
          "HEAD",
        ]);
        const commits = parseLog(committed.stdout);
        if (commits.length !== 1) throw invalidGitOutput();
        commit = commits[0];
      } catch (error) {
        metadataError = this.#refreshError(error);
      }
      const receipt = await this.#refreshReceipt(repository);
      return {
        applied: true,
        commit,
        status: receipt.status,
        refreshError: metadataError ?? receipt.refreshError,
      };
    });
  }

  async checkoutBranch(request = {}) {
    return this.#queueMutation(async () => {
      const input = requestObject(request);
      const name = branchName(input.name);
      const repository = await this.#repository(input);
      await this.#assertValidBranch(repository, name);
      const exists = await this.#run(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
        acceptedExitCodes: [1],
      });
      if (exists.exitCode !== 0) {
        throw new WorkspaceError("BRANCH_NOT_FOUND", "That local branch no longer exists.");
      }
      await this.#run(repository, ["switch", name], {
        mapFailure: (result) => this.#checkoutError(result),
      });
      return { applied: true, branch: name, ...await this.#refreshReceipt(repository) };
    });
  }

  async createBranch(request = {}) {
    return this.#queueMutation(async () => {
      const input = requestObject(request);
      const name = branchName(input.name);
      const repository = await this.#repository(input);
      await this.#assertValidBranch(repository, name);
      const exists = await this.#run(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
        acceptedExitCodes: [1],
      });
      if (exists.exitCode === 0) {
        throw new WorkspaceError("BRANCH_EXISTS", "A local branch with that name already exists.");
      }
      await this.#run(repository, ["switch", "--create", name], {
        mapFailure: (result) => this.#checkoutError(result),
      });
      return { applied: true, branch: name, ...await this.#refreshReceipt(repository) };
    });
  }

  async refreshConflicts(request = {}) {
    const repository = await this.#repository(request);
    const status = await this.#readStatus(repository);
    const conflicts = status.files.filter((file) => file.conflict);
    return { branch: status.branch, conflicts, count: conflicts.length };
  }

  async #repository(request) {
    const input = requestObject(request);
    if (
      typeof input.workspaceId !== "string" ||
      input.workspaceId.length === 0 ||
      input.workspaceId.includes("\0")
    ) {
      throw new WorkspaceError("INVALID_REQUEST", "The Git request is missing its workspace identity.");
    }
    const executionContext = this.#workspaceManager.getExecutionContext(input.workspaceId);
    let probe;
    try {
      probe = await this.#run(executionContext, [
        "rev-parse",
        "--path-format=absolute",
        "--is-inside-work-tree",
        "--show-prefix",
        "--absolute-git-dir",
        "--git-common-dir",
      ], {
        mapFailure: () => notRepositoryError(),
      });
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "GIT_FAILED") throw notRepositoryError();
      throw error;
    }
    const lines = probe.stdout.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
    if (lines.at(-1) === "") lines.pop();
    if (
      lines.length !== 4 ||
      lines[0] !== "true" ||
      lines[1] !== "" ||
      !path.isAbsolute(lines[2]) ||
      !path.isAbsolute(lines[3]) ||
      lines[2].includes("\0") ||
      lines[3].includes("\0")
    ) throw notRepositoryError();

    let canonicalWorkspaceRoot;
    let canonicalGitDir;
    let canonicalCommonDir;
    try {
      [canonicalWorkspaceRoot, canonicalGitDir, canonicalCommonDir] = await Promise.all([
        this.#realpath(executionContext.rootPath),
        this.#realpath(lines[2]),
        this.#realpath(lines[3]),
      ]);
    } catch {
      throw notRepositoryError();
    }
    if (
      !isWithin(canonicalWorkspaceRoot, canonicalGitDir) ||
      !isWithin(canonicalWorkspaceRoot, canonicalCommonDir)
    ) {
      throw notRepositoryError();
    }
    return {
      ...executionContext,
      configuredRootPath: executionContext.rootPath,
      rootPath: canonicalWorkspaceRoot,
      repositoryId: opaqueRepositoryKey(canonicalWorkspaceRoot, canonicalCommonDir),
      gitDir: canonicalGitDir,
      commonDir: canonicalCommonDir,
    };
  }

  async #readStatus(repository) {
    const result = await this.#run(repository, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
    ]);
    return parsePorcelainV2(result.stdout);
  }

  async #readBranches(repository, branchStatus) {
    const result = await this.#run(repository, [
      "for-each-ref",
      `--format=${BRANCH_FORMAT}`,
      "refs/heads",
      "refs/remotes",
    ]);
    const refs = parseBranchRefs(result.stdout);
    return {
      current: branchStatus.current,
      detached: branchStatus.detached,
      unborn: branchStatus.unborn,
      upstream: branchStatus.upstream,
      ahead: branchStatus.ahead,
      behind: branchStatus.behind,
      local: refs.filter((branch) => branch.kind === "local"),
      remote: refs.filter((branch) => branch.kind === "remote"),
    };
  }

  async #assertValidBranch(repository, name) {
    const result = await this.#run(repository, ["check-ref-format", "--branch", name], {
      acceptedExitCodes: [1, 128],
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceError("INVALID_BRANCH", "Enter a valid local branch name.");
    }
  }

  #checkoutError(result) {
    const text = failureText(result);
    if (
      text.includes("would be overwritten by checkout") ||
      text.includes("would be overwritten by switch") ||
      text.includes("you need to resolve your current index first")
    ) {
      return new WorkspaceError("WORKTREE_CONFLICT", "Resolve or save the current changes before switching branches.");
    }
    return new WorkspaceError("CHECKOUT_FAILED", "Git could not switch branches.");
  }

  #queueMutation(operation) {
    const queued = this.#mutationTail.then(operation, operation);
    this.#mutationTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  #refreshError(error) {
    if (error instanceof WorkspaceError) return { code: error.code, message: error.message };
    return { code: "GIT_REFRESH_FAILED", message: "Git changed the repository, but the updated state could not be read." };
  }

  async #refreshReceipt(repository) {
    try {
      return { status: await this.#readStatus(repository), refreshError: null };
    } catch (error) {
      return { status: null, refreshError: this.#refreshError(error) };
    }
  }

  async #run(repository, commandArguments, {
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    input,
    acceptedExitCodes = [],
    mapFailure,
  } = {}) {
    await this.#assertWorkspaceUnchanged(repository);
    const args = [...COMMON_GIT_ARGUMENTS, ...commandArguments];
    let result;
    try {
      const invoke = typeof this.#runner === "function" ? this.#runner : this.#runner.run.bind(this.#runner);
      result = await invoke({ cwd: repository.rootPath, args, input, maxOutputBytes, timeoutMs });
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      const kind = error instanceof GitProcessError ? error.kind : error?.kind;
      if (kind === "unavailable" || ["ENOENT", "EACCES", "ENOEXEC"].includes(error?.code)) {
        throw new WorkspaceError("GIT_UNAVAILABLE", "Git is not installed or cannot be opened.");
      }
      if (kind === "timeout" || error?.code === "ETIMEDOUT") {
        throw new WorkspaceError("GIT_TIMEOUT", "Git took too long to respond.");
      }
      if (kind === "output-limit" || error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        throw new WorkspaceError("GIT_OUTPUT_LIMIT", "Git returned more data than Trace can safely display.");
      }
      throw new WorkspaceError("GIT_FAILED", "The Git operation could not be completed.");
    }

    await this.#assertWorkspaceUnchanged(repository);

    if (
      !result ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      !Number.isInteger(result.exitCode)
    ) {
      throw new WorkspaceError("GIT_FAILED", "The Git operation could not be completed.");
    }
    if (Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") > maxOutputBytes) {
      throw new WorkspaceError("GIT_OUTPUT_LIMIT", "Git returned more data than Trace can safely display.");
    }
    if (result.exitCode !== 0 && !acceptedExitCodes.includes(result.exitCode)) {
      const text = failureText(result);
      if (
        text.includes("not a git repository") ||
        text.includes("not a git directory") ||
        text.includes("must be run in a work tree")
      ) throw notRepositoryError();
      if (typeof mapFailure === "function") throw mapFailure(result);
      throw new WorkspaceError("GIT_FAILED", "The Git operation could not be completed.");
    }
    return result;
  }

  async #assertWorkspaceUnchanged(repository) {
    const currentContext = this.#workspaceManager.getExecutionContext(repository.workspaceId);
    const expectedConfiguredRoot = repository.configuredRootPath ?? repository.rootPath;
    if (path.resolve(currentContext.rootPath) !== path.resolve(expectedConfiguredRoot)) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace changed before Git could finish.");
    }
    if (repository.configuredRootPath === undefined) return;

    let currentCanonicalRoot;
    try {
      currentCanonicalRoot = await this.#realpath(currentContext.rootPath);
    } catch {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace changed before Git could finish.");
    }
    if (path.resolve(currentCanonicalRoot) !== path.resolve(repository.rootPath)) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace changed before Git could finish.");
    }
  }
}

module.exports = {
  BRANCH_FORMAT,
  COMMON_GIT_ARGUMENTS,
  DEFAULT_LOG_COUNT,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DIFF_MAX_OUTPUT_BYTES,
  GitManager,
  GitProcessError,
  LOG_FORMAT,
  MAX_LOG_COUNT,
  MAX_PATHS_PER_OPERATION,
  createGitProcessRunner,
  parseGitHubRemoteUrl,
  parseBranchRefs,
  parseLog,
  parsePorcelainV2,
  safeGitEnvironment,
};
