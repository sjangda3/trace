import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

interface GitRunRequest {
  cwd: string;
  args: string[];
  input?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string | null;
}

interface GitManagerInstance {
  getRepositorySummary(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getRepositoryIdentity(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getGitHubRepository(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getStatus(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getBranches(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getLog(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getFileDiff(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  stage(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  unstage(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  commit(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  checkoutBranch(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  createBranch(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
  refreshConflicts(request?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type Handler = (command: string[], request: GitRunRequest) => GitRunResult | Promise<GitRunResult>;

class FakeWorkspaceManager {
  workspaceId = "workspace-1";
  rootPath = process.cwd();
  readonly requestedWorkspaceIds: unknown[] = [];

  getExecutionContext(expectedWorkspaceId?: unknown) {
    this.requestedWorkspaceIds.push(expectedWorkspaceId);
    if (expectedWorkspaceId !== this.workspaceId) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace changed.");
    }
    return { workspaceId: this.workspaceId, rootPath: this.rootPath };
  }
}

class FakeRunner {
  readonly calls: GitRunRequest[] = [];

  constructor(private readonly handler: Handler) {}

  async run(request: GitRunRequest) {
    this.calls.push(request);
    return this.handler(commandArguments(request.args), request);
  }
}

const require = createRequire(import.meta.url);
const {
  COMMON_GIT_ARGUMENTS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DIFF_MAX_OUTPUT_BYTES,
  GitManager,
  createGitProcessRunner,
  parseBranchRefs,
  parseGitHubRemoteUrl,
  parseLog,
  parsePorcelainV2,
  safeGitEnvironment,
} = require("../electron/git.cjs") as {
  COMMON_GIT_ARGUMENTS: string[];
  DEFAULT_MAX_OUTPUT_BYTES: number;
  DIFF_MAX_OUTPUT_BYTES: number;
  GitManager: new (options: {
    workspaceManager: FakeWorkspaceManager;
    runner: FakeRunner | ((request: GitRunRequest) => Promise<GitRunResult>);
    realpath?: (value: string) => Promise<string>;
  }) => GitManagerInstance;
  createGitProcessRunner(options?: {
    execFile?: (...args: unknown[]) => unknown;
    gitPath?: string;
    environment?: Record<string, string | undefined>;
  }): { run(request: GitRunRequest): Promise<GitRunResult> };
  parseBranchRefs(output: string): Array<Record<string, unknown>>;
  parseGitHubRemoteUrl(value: string): Record<string, string> | null;
  parseLog(output: string): Array<Record<string, unknown>>;
  parsePorcelainV2(output: string): Record<string, unknown>;
  safeGitEnvironment(source?: Record<string, string | undefined>): Record<string, string>;
};
const { WorkspaceError } = require("../electron/workspace.cjs") as {
  WorkspaceError: new (code: string, message: string) => Error & { code: string };
};

const hashA = "a".repeat(40);
const hashB = "b".repeat(40);
const hashC = "c".repeat(40);
const cleanStatus = `# branch.oid ${hashA}\0# branch.head main\0`;

function result(stdout = "", stderr = "", exitCode = 0): GitRunResult {
  return { stdout, stderr, exitCode, signal: null };
}

function commandArguments(args: string[]) {
  expect(args.slice(0, COMMON_GIT_ARGUMENTS.length)).toEqual(COMMON_GIT_ARGUMENTS);
  return args.slice(COMMON_GIT_ARGUMENTS.length);
}

function logRecord({
  hash = hashA,
  parents = "",
  name = "Ada Lovelace",
  email = "ada@example.com",
  date = "2026-07-13T10:00:00-07:00",
  subject = "Ship graph",
} = {}) {
  return [hash, parents, name, email, date, subject].join("\0") + "\0\0";
}

function repositoryProbe(rootPath: string) {
  return `true\n\n${rootPath}\n${rootPath}\n`;
}

function repositoryHandler(rootPath: string, extra?: Handler): Handler {
  return async (command, request) => {
    if (command[0] === "rev-parse") return result(repositoryProbe(rootPath));
    if (command[0] === "status") return result(cleanStatus);
    if (extra) return extra(command, request);
    return result();
  };
}

function thrownBy(action: () => Promise<unknown>) {
  return action().then(
    () => {
      throw new Error("Expected the Git operation to fail.");
    },
    (error) => error,
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Git output parsers", () => {
  it("parses porcelain v2 branch state, renames, conflicts, and untracked files", () => {
    const output = [
      `# branch.oid ${hashA}`,
      "# branch.head feature/collab",
      "# branch.upstream origin/feature/collab",
      "# branch.ab +3 -2",
      `1 M. N... 100644 100644 100644 ${hashA} ${hashB} src/staged file.ts`,
      `2 R. N... 100644 100644 100644 ${hashA} ${hashB} R100 src/new name.ts`,
      "src/old name.ts",
      `u UU N... 100644 100644 100644 100644 ${hashA} ${hashB} ${hashC} src/conflict.ts`,
      "? src/untracked.sql",
      "",
    ].join("\0");

    expect(parsePorcelainV2(output)).toEqual({
      branch: {
        current: "feature/collab",
        oid: hashA,
        upstream: "origin/feature/collab",
        ahead: 3,
        behind: 2,
        detached: false,
        unborn: false,
      },
      files: [
        expect.objectContaining({ path: "src/staged file.ts", staged: true, modified: false }),
        expect.objectContaining({
          path: "src/new name.ts",
          originalPath: "src/old name.ts",
          recordType: "renamed",
          staged: true,
        }),
        expect.objectContaining({ path: "src/conflict.ts", conflict: true, recordType: "unmerged" }),
        expect.objectContaining({ path: "src/untracked.sql", untracked: true }),
      ],
      counts: { total: 4, staged: 3, modified: 1, untracked: 1, conflicts: 1 },
    });
  });

  it("parses local and remote branches while omitting symbolic remote HEAD refs", () => {
    const output = [
      [
        "refs/heads/main",
        "main",
        "*",
        "origin/main",
        "[ahead 2, behind 1]",
        hashA,
        "2026-07-13T09:00:00-07:00",
        "Main subject",
        "",
        "",
      ].join("\0"),
      [
        "refs/remotes/origin/main",
        "origin/main",
        " ",
        "",
        "",
        hashB,
        "2026-07-12T09:00:00-07:00",
        "Remote subject",
        "",
        "",
      ].join("\0"),
      [
        "refs/remotes/origin/HEAD",
        "origin/HEAD",
        " ",
        "",
        "",
        hashB,
        "2026-07-12T09:00:00-07:00",
        "Remote subject",
        "refs/remotes/origin/main",
        "",
      ].join("\0"),
      "",
    ].join("\n");

    expect(parseBranchRefs(output)).toEqual([
      expect.objectContaining({
        kind: "local",
        name: "main",
        current: true,
        upstream: "origin/main",
        ahead: 2,
        behind: 1,
      }),
      expect.objectContaining({ kind: "remote", name: "origin/main", current: false }),
    ]);
  });

  it("parses bounded graph records with parent hashes and author metadata", () => {
    const output = logRecord({ hash: hashA, parents: `${hashB} ${hashC}` }) +
      logRecord({ hash: hashB, parents: hashC, subject: "Parent" });
    expect(parseLog(output)).toEqual([
      {
        hash: hashA,
        parents: [hashB, hashC],
        author: { name: "Ada Lovelace", email: "ada@example.com" },
        date: "2026-07-13T10:00:00-07:00",
        subject: "Ship graph",
      },
      expect.objectContaining({ hash: hashB, parents: [hashC], subject: "Parent" }),
    ]);
  });

  it("rejects unsafe paths returned by malformed Git output", () => {
    expect(() => parsePorcelainV2(`? ../outside.txt\0`)).toThrowError(
      expect.objectContaining({ code: "GIT_INVALID_OUTPUT" }),
    );
  });

  it("preserves legal tab and newline characters in NUL-delimited file paths", () => {
    expect(parsePorcelainV2("? folder/line\tbreak\nfile.ts\0")).toMatchObject({
      files: [expect.objectContaining({ path: "folder/line\tbreak\nfile.ts", untracked: true })],
    });
  });

  it("normalizes credential-free GitHub HTTPS, SCP, and SSH remotes", () => {
    const expected = {
      provider: "github",
      host: "github.com",
      owner: "openai",
      repository: "trace",
      fullName: "openai/trace",
    };
    expect(parseGitHubRemoteUrl("https://github.com/openai/trace.git")).toEqual(expected);
    expect(parseGitHubRemoteUrl("git@github.com:openai/trace.git")).toEqual(expected);
    expect(parseGitHubRemoteUrl("ssh://git@github.com/openai/trace.git")).toEqual(expected);
  });

  it("rejects credential-bearing, non-GitHub, malformed, and nested remotes", () => {
    expect(parseGitHubRemoteUrl("https://token@github.com/openai/trace.git")).toBeNull();
    expect(parseGitHubRemoteUrl("https://gitlab.com/openai/trace.git")).toBeNull();
    expect(parseGitHubRemoteUrl("git@github.com:openai/team/trace.git")).toBeNull();
    expect(parseGitHubRemoteUrl("ssh://alice@github.com/openai/trace.git")).toBeNull();
    expect(parseGitHubRemoteUrl("https://github.com/openai/trace.git?token=secret")).toBeNull();
  });
});

describe("GitManager backend", () => {
  let workspaceManager: FakeWorkspaceManager;

  beforeEach(() => {
    workspaceManager = new FakeWorkspaceManager();
  });

  it("binds every summary read to the exact workspace and returns status plus branches", async () => {
    const branchOutput = [
      "refs/heads/main",
      "main",
      "*",
      "origin/main",
      "[ahead 1]",
      hashA,
      "2026-07-13T10:00:00-07:00",
      "Ready",
      "",
      "",
    ].join("\0") + "\n";
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, (command) => {
      if (command[0] === "for-each-ref") return result(branchOutput);
      throw new Error(`Unexpected command ${command[0]}`);
    }));
    const manager = new GitManager({ workspaceManager, runner });

    await expect(manager.getRepositorySummary({ workspaceId: workspaceManager.workspaceId })).resolves.toMatchObject({
      workspaceId: workspaceManager.workspaceId,
      repositoryRoot: "",
      head: hashA,
      status: { counts: { total: 0 } },
      branches: { current: "main", local: [expect.objectContaining({ name: "main" })] },
    });
    expect(workspaceManager.requestedWorkspaceIds.length).toBeGreaterThan(1);
    expect(workspaceManager.requestedWorkspaceIds.every((id) => id === workspaceManager.workspaceId)).toBe(true);
    expect(runner.calls.every((call) => call.cwd === workspaceManager.rootPath)).toBe(true);
    expect(runner.calls.every((call) => Array.isArray(call.args))).toBe(true);
  });

  it("keeps a configured workspace root bound when its canonical macOS path differs", async () => {
    workspaceManager.rootPath = "/var/folders/project";
    const canonicalRoot = "/private/var/folders/project";
    const gitDir = `${canonicalRoot}/.git`;
    const runner = new FakeRunner((command) => {
      if (command[0] === "rev-parse") return result(repositoryProbe(gitDir));
      if (command[0] === "status") return result(cleanStatus);
      return result();
    });
    const manager = new GitManager({
      workspaceManager,
      runner,
      realpath: async (value: string) => {
        if (value === workspaceManager.rootPath) return canonicalRoot;
        if (value === gitDir) return gitDir;
        throw new Error(`Unexpected realpath ${value}`);
      },
    });

    await expect(manager.getStatus({ workspaceId: workspaceManager.workspaceId })).resolves.toMatchObject({
      branch: { current: "main" },
      counts: { total: 0 },
    });
    expect(runner.calls.map((call) => call.cwd)).toEqual([
      workspaceManager.rootPath,
      canonicalRoot,
    ]);
  });

  it("binds GitHub identity to the upstream remote, then origin, without exposing raw URLs", async () => {
    const runner = new FakeRunner((command) => {
      if (command[0] === "rev-parse") return result(repositoryProbe(workspaceManager.rootPath));
      if (command[0] === "status") {
        return result(`${cleanStatus}# branch.upstream company/main\0`);
      }
      if (command[0] === "remote" && command.length === 1) {
        return result("origin\ncompany\nprivate-token\n");
      }
      if (command[0] === "remote" && command[1] === "get-url") {
        if (command.at(-1) === "origin") return result("https://github.com/example/fallback.git\n");
        if (command.at(-1) === "company") return result("git@github.com:example/product.git\n");
        return result("https://secret@github.com/example/private.git\n");
      }
      return result();
    });
    const manager = new GitManager({ workspaceManager, runner });

    await expect(manager.getRepositoryIdentity({ workspaceId: workspaceManager.workspaceId })).resolves.toMatchObject({
      workspaceId: workspaceManager.workspaceId,
      localRepositoryKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      upstreamRemote: "company",
      remotes: [
        expect.objectContaining({ name: "origin", fullName: "example/fallback" }),
        expect.objectContaining({ name: "company", fullName: "example/product" }),
      ],
    });
    const selected = await manager.getGitHubRepository({ workspaceId: workspaceManager.workspaceId });
    expect(selected).toMatchObject({
      remoteName: "company",
      owner: "example",
      repository: "product",
      fullName: "example/product",
    });
    expect(JSON.stringify(selected)).not.toContain("secret");
    expect(JSON.stringify(selected)).not.toContain(workspaceManager.rootPath);
  });

  it("requires an explicit binding when several GitHub remotes have no upstream or origin", async () => {
    const runner = new FakeRunner((command) => {
      if (command[0] === "rev-parse") return result(repositoryProbe(workspaceManager.rootPath));
      if (command[0] === "status") return result(cleanStatus);
      if (command[0] === "remote" && command.length === 1) return result("fork\nupstream\n");
      if (command[0] === "remote" && command[1] === "get-url") {
        return result(`git@github.com:example/${command.at(-1)}.git\n`);
      }
      return result();
    });
    const manager = new GitManager({ workspaceManager, runner });
    await expect(manager.getGitHubRepository({ workspaceId: workspaceManager.workspaceId })).rejects.toMatchObject({
      code: "AMBIGUOUS_GITHUB_REMOTE",
    });
  });

  it("rejects repositories whose top-level directory escapes the workspace", async () => {
    const runner = new FakeRunner(() => result("/tmp\n"));
    const manager = new GitManager({ workspaceManager, runner });
    await expect(manager.getStatus({ workspaceId: workspaceManager.workspaceId })).rejects.toMatchObject({
      code: "NOT_A_REPOSITORY",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("rejects repositories whose Git metadata or common directory escapes the workspace", async () => {
    const runner = new FakeRunner(() => result("true\n\n/tmp\n/tmp\n"));
    const manager = new GitManager({ workspaceManager, runner });
    await expect(manager.getStatus({ workspaceId: workspaceManager.workspaceId })).rejects.toMatchObject({
      code: "NOT_A_REPOSITORY",
    });
  });

  it("rejects stale or missing workspace identities before starting Git", async () => {
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath));
    const manager = new GitManager({ workspaceManager, runner });
    await expect(manager.getStatus({ workspaceId: "workspace-that-was-closed" })).rejects.toMatchObject({
      code: "WORKSPACE_CHANGED",
    });
    await expect(manager.getStatus({})).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(runner.calls).toHaveLength(0);
  });

  it("validates pathspecs before mutation and always terminates path options with --", async () => {
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath));
    const manager = new GitManager({ workspaceManager, runner });

    await expect(manager.stage({
      workspaceId: workspaceManager.workspaceId,
      paths: ["../outside.txt"],
    })).rejects.toMatchObject({ code: "OUTSIDE_WORKSPACE" });
    expect(runner.calls.map((call) => commandArguments(call.args)[0])).toEqual(["rev-parse"]);

    await manager.stage({
      workspaceId: workspaceManager.workspaceId,
      paths: ["src/app.ts", "src/app.ts", "-literal-name.ts", "*.txt", "[literal]?.ts", ":literal.ts"],
    });
    await manager.unstage({
      workspaceId: workspaceManager.workspaceId,
      paths: ["src/app.ts"],
    });
    const commands = runner.calls.map((call) => commandArguments(call.args));
    expect(COMMON_GIT_ARGUMENTS).toContain("--literal-pathspecs");
    expect(commands).toContainEqual([
      "add",
      "--all",
      "--",
      "src/app.ts",
      "-literal-name.ts",
      "*.txt",
      "[literal]?.ts",
      ":literal.ts",
    ]);
    expect(commands).toContainEqual(["reset", "--quiet", "--", "src/app.ts"]);
  });

  it("returns an applied receipt when status refresh fails after a mutation", async () => {
    let statusReads = 0;
    const runner = new FakeRunner((command) => {
      if (command[0] === "rev-parse") return result(repositoryProbe(workspaceManager.rootPath));
      if (command[0] === "add") return result();
      if (command[0] === "status") {
        statusReads += 1;
        return result("", "fatal: status unavailable", 1);
      }
      return result();
    });
    const manager = new GitManager({ workspaceManager, runner });

    await expect(manager.stage({
      workspaceId: workspaceManager.workspaceId,
      paths: ["src/app.ts"],
    })).resolves.toEqual({
      applied: true,
      paths: ["src/app.ts"],
      status: null,
      refreshError: {
        code: "GIT_FAILED",
        message: "The Git operation could not be completed.",
      },
    });
    expect(statusReads).toBe(1);
    expect(runner.calls.map((call) => commandArguments(call.args)[0])).toEqual([
      "rev-parse",
      "add",
      "status",
    ]);
  });

  it("serializes concurrent mutations through their post-mutation refreshes", async () => {
    const firstAddStarted = deferred<void>();
    const releaseFirstAdd = deferred<void>();
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, async (command) => {
      if (command[0] === "add" && command.at(-1) === "src/first.ts") {
        firstAddStarted.resolve();
        await releaseFirstAdd.promise;
      }
      return result();
    }));
    const manager = new GitManager({ workspaceManager, runner });

    const first = manager.stage({
      workspaceId: workspaceManager.workspaceId,
      paths: ["src/first.ts"],
    });
    const second = manager.stage({
      workspaceId: workspaceManager.workspaceId,
      paths: ["src/second.ts"],
    });

    await firstAddStarted.promise;
    expect(runner.calls.map((call) => commandArguments(call.args))).toEqual([
      expect.arrayContaining(["rev-parse"]),
      ["add", "--all", "--", "src/first.ts"],
    ]);

    releaseFirstAdd.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ applied: true, paths: ["src/first.ts"] }),
      expect.objectContaining({ applied: true, paths: ["src/second.ts"] }),
    ]);
    expect(runner.calls.map((call) => commandArguments(call.args)[0])).toEqual([
      "rev-parse",
      "add",
      "status",
      "rev-parse",
      "add",
      "status",
    ]);
  });

  it("rejects a mutation if the workspace identity changes while Git is running", async () => {
    const addStarted = deferred<void>();
    const releaseAdd = deferred<void>();
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, async (command) => {
      if (command[0] === "add") {
        addStarted.resolve();
        await releaseAdd.promise;
      }
      return result();
    }));
    const manager = new GitManager({ workspaceManager, runner });
    const mutation = manager.stage({
      workspaceId: workspaceManager.workspaceId,
      paths: ["src/app.ts"],
    });

    await addStarted.promise;
    workspaceManager.workspaceId = "workspace-2";
    releaseAdd.resolve();

    await expect(mutation).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    expect(runner.calls.map((call) => commandArguments(call.args)[0])).toEqual([
      "rev-parse",
      "add",
    ]);
  });

  it("rejects an aggregate path payload before it can exceed the process argument budget", async () => {
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath));
    const manager = new GitManager({ workspaceManager, runner });
    const paths = Array.from({ length: 40 }, (_, index) => `${index}-${"x".repeat(3_500)}.ts`);
    await expect(manager.stage({ workspaceId: workspaceManager.workspaceId, paths })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(runner.calls.map((call) => commandArguments(call.args)[0])).toEqual(["rev-parse"]);
  });

  it("builds working, staged, and commit file diffs without external diff processes", async () => {
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, (command) => {
      if (command[0] === "diff" || command[0] === "show") return result("diff --git a/src/a.ts b/src/a.ts\n");
      return result();
    }));
    const manager = new GitManager({ workspaceManager, runner });

    await manager.getFileDiff({ workspaceId: workspaceManager.workspaceId, path: "src/a.ts", mode: "working" });
    await manager.getFileDiff({ workspaceId: workspaceManager.workspaceId, path: "src/a.ts", mode: "staged" });
    await expect(manager.getFileDiff({
      workspaceId: workspaceManager.workspaceId,
      path: "src/a.ts",
      mode: "commit",
      commit: hashB,
    })).resolves.toMatchObject({ mode: "commit", commit: hashB, patch: expect.stringContaining("diff --git") });

    const diffCommands = runner.calls
      .map((call) => ({ command: commandArguments(call.args), max: call.maxOutputBytes }))
      .filter(({ command }) => ["diff", "show"].includes(command[0]));
    expect(diffCommands).toEqual([
      { command: ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--", "src/a.ts"], max: DIFF_MAX_OUTPUT_BYTES },
      { command: ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=3", "--", "src/a.ts"], max: DIFF_MAX_OUTPUT_BYTES },
      {
        command: ["show", "--format=", "--no-ext-diff", "--no-textconv", "--unified=3", hashB, "--", "src/a.ts"],
        max: DIFF_MAX_OUTPUT_BYTES,
      },
    ]);
    await expect(manager.getFileDiff({
      workspaceId: workspaceManager.workspaceId,
      path: "src/a.ts",
      mode: "commit",
      commit: "--all",
    })).rejects.toMatchObject({ code: "INVALID_COMMIT" });
  });

  it("synthesizes a no-index patch for an untracked working file", async () => {
    const untrackedStatus = `${cleanStatus}? notes/new file.txt\0`;
    const runner = new FakeRunner((command) => {
      if (command[0] === "rev-parse") return result(repositoryProbe(workspaceManager.rootPath));
      if (command[0] === "status") return result(untrackedStatus);
      if (command[0] === "diff") return result("diff --git a/notes/new file.txt b/notes/new file.txt\n", "", 1);
      return result();
    });
    const manager = new GitManager({ workspaceManager, runner });
    await expect(manager.getFileDiff({
      workspaceId: workspaceManager.workspaceId,
      path: "notes/new file.txt",
      mode: "working",
    })).resolves.toMatchObject({ patch: expect.stringContaining("new file.txt") });
    expect(runner.calls.map((call) => commandArguments(call.args))).toContainEqual([
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      "--",
      "/dev/null",
      "notes/new file.txt",
    ]);
  });

  it("caps log pagination and reports whether another graph page exists", async () => {
    const commits = Array.from({ length: 4 }, (_, index) => logRecord({
      hash: String(index + 1).repeat(40),
      subject: `Commit ${index + 1}`,
    })).join("");
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, (command) => {
      if (command[0] === "log") return result(commits);
      return result();
    }));
    const manager = new GitManager({ workspaceManager, runner });

    await expect(manager.getLog({ workspaceId: workspaceManager.workspaceId, maxCount: 3, skip: 7 })).resolves.toMatchObject({
      commits: [{ subject: "Commit 1" }, { subject: "Commit 2" }, { subject: "Commit 3" }],
      maxCount: 3,
      skip: 7,
      hasMore: true,
    });
    const logCommand = runner.calls.map((call) => commandArguments(call.args)).find((command) => command[0] === "log");
    expect(logCommand).toEqual(expect.arrayContaining(["--all", "--topo-order", "--max-count=4", "--skip=7"]));
    await expect(manager.getLog({ workspaceId: workspaceManager.workspaceId, maxCount: 201 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("commits staged changes without hooks or signing and returns the new commit", async () => {
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, (command) => {
      if (command[0] === "commit") return result();
      if (command[0] === "log") return result(logRecord({ hash: hashC, subject: "Pair safely" }));
      return result();
    }));
    const manager = new GitManager({ workspaceManager, runner });

    await expect(manager.commit({
      workspaceId: workspaceManager.workspaceId,
      message: "Pair safely",
    })).resolves.toMatchObject({ commit: { hash: hashC, subject: "Pair safely" } });
    const commitCall = runner.calls.find((call) => commandArguments(call.args)[0] === "commit");
    expect(commitCall && commandArguments(commitCall.args)).toEqual(["commit", "--no-verify", "--quiet", "--file=-"]);
    expect(commitCall?.input).toBe("Pair safely");
    expect(COMMON_GIT_ARGUMENTS).toEqual(expect.arrayContaining(["-c", "commit.gpgsign=false"]));
    expect(COMMON_GIT_ARGUMENTS.some((argument) => argument.startsWith("core.hooksPath="))).toBe(true);
  });

  it("maps commit and checkout failures to actionable errors without leaking stderr", async () => {
    const secret = "oauth-token-should-not-leak";
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, (command) => {
      if (command[0] === "commit") return result("", `nothing to commit ${secret}`, 1);
      return result();
    }));
    const manager = new GitManager({ workspaceManager, runner });
    const error = await thrownBy(() => manager.commit({
      workspaceId: workspaceManager.workspaceId,
      message: "Noop",
    })) as Error & { code: string };
    expect(error.code).toBe("NOTHING_TO_COMMIT");
    expect(error.message).not.toContain(secret);
  });

  it("checks branch refs before switching or creating and never interprets names as options", async () => {
    const existingRefs = new Set(["refs/heads/main"]);
    const runner = new FakeRunner(repositoryHandler(workspaceManager.rootPath, (command) => {
      if (command[0] === "check-ref-format") return result();
      if (command[0] === "show-ref") return result("", "", existingRefs.has(command[3]) ? 0 : 1);
      if (command[0] === "switch") return result();
      return result();
    }));
    const manager = new GitManager({ workspaceManager, runner });

    await expect(manager.checkoutBranch({ workspaceId: workspaceManager.workspaceId, name: "main" })).resolves.toMatchObject({
      branch: "main",
    });
    await expect(manager.createBranch({ workspaceId: workspaceManager.workspaceId, name: "feature/presence" })).resolves.toMatchObject({
      branch: "feature/presence",
    });
    const commands = runner.calls.map((call) => commandArguments(call.args));
    expect(commands).toContainEqual(["switch", "main"]);
    expect(commands).toContainEqual(["switch", "--create", "feature/presence"]);
    await expect(manager.createBranch({ workspaceId: workspaceManager.workspaceId, name: "--orphan" })).rejects.toMatchObject({
      code: "INVALID_BRANCH",
    });
    await expect(manager.createBranch({ workspaceId: workspaceManager.workspaceId, name: "@" })).rejects.toMatchObject({
      code: "INVALID_BRANCH",
    });
  });

  it("refreshes and returns only unresolved conflicts", async () => {
    const conflictStatus = [
      `# branch.oid ${hashA}`,
      "# branch.head main",
      `u UU N... 100644 100644 100644 100644 ${hashA} ${hashB} ${hashC} src/conflict.ts`,
      "? src/new.ts",
      "",
    ].join("\0");
    const runner = new FakeRunner((command) => {
      if (command[0] === "rev-parse") return result(repositoryProbe(workspaceManager.rootPath));
      if (command[0] === "status") return result(conflictStatus);
      return result();
    });
    const manager = new GitManager({ workspaceManager, runner });
    await expect(manager.refreshConflicts({ workspaceId: workspaceManager.workspaceId })).resolves.toMatchObject({
      count: 1,
      conflicts: [expect.objectContaining({ path: "src/conflict.ts", conflict: true })],
    });
  });

  it("gracefully distinguishes missing Git and non-repositories", async () => {
    const unavailable = new GitManager({
      workspaceManager,
      runner: async () => {
        throw Object.assign(new Error("spawn git ENOENT /private/secret"), { code: "ENOENT" });
      },
    });
    const unavailableError = await thrownBy(() => unavailable.getStatus({
      workspaceId: workspaceManager.workspaceId,
    })) as Error & { code: string };
    expect(unavailableError).toMatchObject({ code: "GIT_UNAVAILABLE" });
    expect(unavailableError.message).not.toContain("/private/secret");

    const notRepository = new GitManager({
      workspaceManager,
      runner: async () => result("", "fatal: not a git repository /private/secret", 128),
    });
    const repositoryError = await thrownBy(() => notRepository.getStatus({
      workspaceId: workspaceManager.workspaceId,
    })) as Error & { code: string };
    expect(repositoryError).toMatchObject({ code: "NOT_A_REPOSITORY" });
    expect(repositoryError.message).not.toContain("/private/secret");
  });

  it("enforces output caps even for an injected runner", async () => {
    const runner = new FakeRunner((command) => {
      if (command[0] === "rev-parse") return result(repositoryProbe(workspaceManager.rootPath));
      if (command[0] === "status") return result("x".repeat(DEFAULT_MAX_OUTPUT_BYTES + 1));
      return result();
    });
    const manager = new GitManager({ workspaceManager, runner });
    await expect(manager.getStatus({ workspaceId: workspaceManager.workspaceId })).rejects.toMatchObject({
      code: "GIT_OUTPUT_LIMIT",
    });
  });
});

describe("Git process runner", () => {
  it("uses execFile without a shell and forwards only a credential-safe environment", async () => {
    let executable: unknown;
    let argumentsList: unknown;
    let options: Record<string, unknown> | undefined;
    const execFile = (...args: unknown[]) => {
      executable = args[0];
      argumentsList = args[1];
      options = args[2] as Record<string, unknown>;
      const callback = args[3] as (error: null, stdout: string, stderr: string) => void;
      callback(null, "ok", "");
    };
    const runner = createGitProcessRunner({
      execFile,
      gitPath: "/usr/bin/git",
      environment: {
        PATH: "/usr/bin:/bin",
        HOME: "/Users/test",
        GITHUB_TOKEN: "secret",
        SSH_AUTH_SOCK: "/private/agent.sock",
        GIT_AUTHOR_NAME: "Test User",
      },
    });

    await expect(runner.run({
      cwd: "/tmp/project",
      args: ["status", "--porcelain=v2"],
      timeoutMs: 123,
      maxOutputBytes: 456,
    })).resolves.toMatchObject({ stdout: "ok", exitCode: 0 });
    expect(executable).toBe("/usr/bin/git");
    expect(argumentsList).toEqual(["status", "--porcelain=v2"]);
    expect(options).toMatchObject({ cwd: "/tmp/project", shell: false, timeout: 123, maxBuffer: 456 });
    expect(options?.env).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/test",
      GIT_AUTHOR_NAME: "Test User",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
    });
    expect(options?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(options?.env).not.toHaveProperty("SSH_AUTH_SOCK");
  });

  it("builds the same sanitized environment independently", () => {
    expect(safeGitEnvironment({
      PATH: "/bin",
      AWS_SECRET_ACCESS_KEY: "secret",
      GIT_COMMITTER_EMAIL: "test@example.com",
    })).toMatchObject({
      PATH: "/bin",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
  });
});
