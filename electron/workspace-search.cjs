const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { WorkspaceError } = require("./workspace.cjs");

const DEFAULT_MAX_RESULTS = 500;
const MAX_RESULTS = 2_000;
const MAX_QUERY_BYTES = 512;
const MAX_REQUEST_ID_BYTES = 128;
const MAX_WORKSPACE_ID_BYTES = 8_192;
const MAX_PATH_BYTES = 4_096;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 768 * 1024;
const MAX_PREVIEW_CHARS = 640;
const READ_CHUNK_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORD_CHARACTER_PATTERN = /[A-Za-z0-9_$]/;

function invalidRequest(message = "The workspace search request is invalid.") {
  return new WorkspaceError("INVALID_REQUEST", message);
}

function requireRecord(value, message = "The workspace search request is invalid.") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest(message);
  return value;
}

function assertOnlyKeys(value, keys, message = "The workspace search request is invalid.") {
  if (Object.keys(value).some((key) => !keys.has(key))) throw invalidRequest(message);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function boundedIdentity(value, pattern, maximumBytes, message) {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    byteLength(value) > maximumBytes ||
    !pattern.test(value)
  ) {
    throw invalidRequest(message);
  }
  return value;
}

function normalizeWorkspaceId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    byteLength(value) > MAX_WORKSPACE_ID_BYTES
  ) {
    throw invalidRequest("The search request is missing its workspace identity.");
  }
  return value;
}

function normalizeRequestId(value) {
  return boundedIdentity(
    value,
    REQUEST_ID_PATTERN,
    MAX_REQUEST_ID_BYTES,
    "A valid search request identity is required.",
  );
}

function normalizeClient(context = {}) {
  const input = requireRecord(context, "The search client identity is invalid.");
  const value = input.clientId ?? "local-window";
  return boundedIdentity(
    value,
    CLIENT_ID_PATTERN,
    MAX_REQUEST_ID_BYTES,
    "The search client identity is invalid.",
  );
}

function normalizeBoolean(value, fallback, message) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw invalidRequest(message);
  return value;
}

function normalizeSearchRequest(request) {
  const input = requireRecord(request);
  assertOnlyKeys(
    input,
    new Set(["workspaceId", "requestId", "query", "caseSensitive", "wholeWord", "maxResults"]),
  );
  if (
    typeof input.query !== "string" ||
    input.query.length === 0 ||
    input.query.includes("\0") ||
    input.query.includes("\n") ||
    input.query.includes("\r") ||
    byteLength(input.query) > MAX_QUERY_BYTES
  ) {
    throw invalidRequest("Enter a single-line search term no longer than 512 bytes.");
  }
  const maxResults = input.maxResults === undefined ? DEFAULT_MAX_RESULTS : input.maxResults;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw invalidRequest(`Search results are limited to ${MAX_RESULTS.toLocaleString("en-US")} matches.`);
  }
  return {
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    requestId: normalizeRequestId(input.requestId),
    query: input.query,
    caseSensitive: normalizeBoolean(input.caseSensitive, false, "The case-sensitivity option is invalid."),
    wholeWord: normalizeBoolean(input.wholeWord, false, "The whole-word option is invalid."),
    maxResults,
  };
}

function normalizeCancelRequest(request) {
  const input = requireRecord(request, "The search cancellation request is invalid.");
  assertOnlyKeys(
    input,
    new Set(["workspaceId", "requestId"]),
    "The search cancellation request is invalid.",
  );
  return {
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    requestId: normalizeRequestId(input.requestId),
  };
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isSafeTreePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    byteLength(value) > MAX_PATH_BYTES
  ) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    normalized.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function collectSearchableFiles(nodes, state) {
  if (!Array.isArray(nodes)) return;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (state.files.length >= MAX_FILES) {
      state.truncated = true;
      return;
    }
    if (!node || typeof node !== "object") continue;
    if (node.type === "file") {
      if (!isSafeTreePath(node.path)) {
        state.skippedFiles += 1;
        continue;
      }
      state.files.push({
        path: node.path,
        size: Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null,
      });
      continue;
    }
    if (node.type === "folder" && !node.ignored) collectSearchableFiles(node.children, state);
    if (state.files.length >= MAX_FILES) {
      if (index < nodes.length - 1) state.truncated = true;
      return;
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWholeWord(line, start, end) {
  const before = start > 0 ? line[start - 1] : "";
  const after = end < line.length ? line[end] : "";
  return !WORD_CHARACTER_PATTERN.test(before) && !WORD_CHARACTER_PATTERN.test(after);
}

function previewFor(line, start, end) {
  if (line.length <= MAX_PREVIEW_CHARS) {
    return {
      preview: line,
      previewStartColumn: 1,
      previewTruncatedStart: false,
      previewTruncatedEnd: false,
    };
  }
  const matchLength = Math.max(1, end - start);
  const contextBudget = Math.max(0, MAX_PREVIEW_CHARS - Math.min(matchLength, MAX_PREVIEW_CHARS));
  let previewStart = Math.max(0, start - Math.floor(contextBudget / 2));
  let previewEnd = Math.min(line.length, previewStart + Math.max(MAX_PREVIEW_CHARS, matchLength));
  if (previewEnd === line.length) previewStart = Math.max(0, previewEnd - Math.max(MAX_PREVIEW_CHARS, matchLength));
  return {
    preview: line.slice(previewStart, previewEnd),
    previewStartColumn: previewStart + 1,
    previewTruncatedStart: previewStart > 0,
    previewTruncatedEnd: previewEnd < line.length,
  };
}

async function readBoundedUtf8File(rootPath, relativePath) {
  const lexicalPath = path.resolve(rootPath, ...relativePath.split("/"));
  if (!isWithin(rootPath, lexicalPath)) return null;

  let handle;
  try {
    const canonicalParent = await fsp.realpath(path.dirname(lexicalPath));
    if (!isWithin(rootPath, canonicalParent)) return null;
    const targetPath = path.join(canonicalParent, path.basename(lexicalPath));
    const openedStats = await fsp.lstat(targetPath);
    if (openedStats.isSymbolicLink() || !openedStats.isFile() || openedStats.size > MAX_FILE_BYTES) return null;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    handle = await fsp.open(targetPath, flags);
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      stats.size > MAX_FILE_BYTES ||
      stats.dev !== openedStats.dev ||
      stats.ino !== openedStats.ino
    ) return null;

    const chunks = [];
    let totalBytes = 0;
    const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (totalBytes <= MAX_FILE_BYTES) {
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_FILE_BYTES) return null;
      const chunk = Buffer.from(readBuffer.subarray(0, bytesRead));
      if (chunk.includes(0)) return null;
      chunks.push(chunk);
    }

    const contents = Buffer.concat(chunks, totalBytes);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    } catch {
      return null;
    }
    return { text, bytes: totalBytes };
  } catch (error) {
    if (["EACCES", "EISDIR", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].includes(error?.code)) return null;
    throw new WorkspaceError("IO_ERROR", "The workspace search could not read a file safely.");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function cancelledError() {
  return new WorkspaceError("SEARCH_CANCELLED", "The workspace search was cancelled.");
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

class WorkspaceSearchManager {
  #workspaceManager;
  #jobs = new Map();
  #now;
  #yieldControl;

  constructor({ workspaceManager, now = () => Date.now(), yieldControl = yieldToEventLoop } = {}) {
    if (
      !workspaceManager ||
      typeof workspaceManager.getExecutionContext !== "function" ||
      typeof workspaceManager.getTree !== "function"
    ) {
      throw new TypeError("WorkspaceSearchManager requires a workspace manager.");
    }
    if (typeof now !== "function" || typeof yieldControl !== "function") {
      throw new TypeError("WorkspaceSearchManager requires valid scheduling dependencies.");
    }
    this.#workspaceManager = workspaceManager;
    this.#now = now;
    this.#yieldControl = yieldControl;
  }

  async search(request = {}, context = {}) {
    const input = normalizeSearchRequest(request);
    const clientId = normalizeClient(context);
    const key = this.#jobKey(clientId, input.requestId);
    if (this.#jobs.has(key)) {
      throw new WorkspaceError("SEARCH_IN_PROGRESS", "That search request is already running.");
    }

    const workspace = this.#captureWorkspace(input.workspaceId);
    const job = { clientId, requestId: input.requestId, workspaceId: input.workspaceId, cancelled: false };
    this.#jobs.set(key, job);
    const startedAt = this.#timestamp();

    try {
      const treeResult = await this.#workspaceManager.getTree(input.workspaceId);
      this.#throwIfCancelled(job);
      this.#assertWorkspace(workspace);

      const collected = { files: [], skippedFiles: 0, truncated: Boolean(treeResult?.truncated) };
      collectSearchableFiles(treeResult?.tree, collected);
      const files = [];
      let activeFile = null;
      let matchCount = 0;
      let filesScanned = 0;
      let filesSkipped = collected.skippedFiles;
      let bytesScanned = 0;
      let outputBytes = 256 + byteLength(input.workspaceId) + byteLength(input.requestId) + byteLength(input.query);
      let truncated = collected.truncated;
      const matcher = new RegExp(escapeRegExp(input.query), input.caseSensitive ? "g" : "gi");

      fileLoop:
      for (const candidate of collected.files) {
        this.#throwIfCancelled(job);
        this.#assertWorkspace(workspace);
        if (candidate.size !== null && candidate.size > MAX_FILE_BYTES) {
          filesSkipped += 1;
          continue;
        }
        if (candidate.size !== null && bytesScanned + candidate.size > MAX_TOTAL_BYTES) {
          filesSkipped += 1;
          truncated = true;
          continue;
        }

        const opened = await readBoundedUtf8File(workspace.rootPath, candidate.path);
        this.#throwIfCancelled(job);
        this.#assertWorkspace(workspace);
        filesScanned += 1;
        if (!opened) {
          filesSkipped += 1;
          await this.#yieldControl();
          continue;
        }
        if (bytesScanned + opened.bytes > MAX_TOTAL_BYTES) {
          filesSkipped += 1;
          truncated = true;
          continue;
        }
        bytesScanned += opened.bytes;

        const lines = opened.text.split("\n");
        activeFile = null;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          if (lineIndex > 0 && lineIndex % 256 === 0) {
            await this.#yieldControl();
            this.#throwIfCancelled(job);
            this.#assertWorkspace(workspace);
          }
          const line = lines[lineIndex].endsWith("\r") ? lines[lineIndex].slice(0, -1) : lines[lineIndex];
          matcher.lastIndex = 0;
          let found;
          while ((found = matcher.exec(line)) !== null) {
            const start = found.index;
            const end = start + found[0].length;
            if (input.wholeWord && !isWholeWord(line, start, end)) continue;
            const match = {
              line: lineIndex + 1,
              column: start + 1,
              endColumn: end + 1,
              ...previewFor(line, start, end),
            };
            const matchBytes = byteLength(JSON.stringify(match)) + 1;
            const fileBytes = activeFile ? 0 : byteLength(candidate.path) + 48;
            if (outputBytes + fileBytes + matchBytes > MAX_OUTPUT_BYTES) {
              truncated = true;
              break fileLoop;
            }
            if (!activeFile) {
              activeFile = { path: candidate.path, matches: [] };
              files.push(activeFile);
              outputBytes += fileBytes;
            }
            activeFile.matches.push(match);
            outputBytes += matchBytes;
            matchCount += 1;
            if (matchCount >= input.maxResults) {
              truncated = true;
              break fileLoop;
            }
          }
        }
        await this.#yieldControl();
      }

      this.#throwIfCancelled(job);
      this.#assertWorkspace(workspace);
      return {
        workspaceId: input.workspaceId,
        requestId: input.requestId,
        query: input.query,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        files,
        matchCount,
        filesScanned,
        filesSkipped,
        bytesScanned,
        truncated,
        durationMs: Math.max(0, this.#timestamp() - startedAt),
      };
    } finally {
      if (this.#jobs.get(key) === job) this.#jobs.delete(key);
    }
  }

  cancel(request = {}, context = {}) {
    const input = normalizeCancelRequest(request);
    const clientId = normalizeClient(context);
    const job = this.#jobs.get(this.#jobKey(clientId, input.requestId));
    if (!job || job.workspaceId !== input.workspaceId) {
      return { workspaceId: input.workspaceId, requestId: input.requestId, cancelled: false };
    }
    job.cancelled = true;
    return { workspaceId: input.workspaceId, requestId: input.requestId, cancelled: true };
  }

  disposeWorkspace(workspaceId) {
    if (typeof workspaceId !== "string") return;
    for (const job of this.#jobs.values()) {
      if (job.workspaceId === workspaceId) job.cancelled = true;
    }
  }

  disposeClient(clientId) {
    if (typeof clientId !== "string") return;
    for (const job of this.#jobs.values()) {
      if (job.clientId === clientId) job.cancelled = true;
    }
  }

  dispose() {
    for (const job of this.#jobs.values()) job.cancelled = true;
    this.#jobs.clear();
  }

  #captureWorkspace(workspaceId) {
    const context = this.#workspaceManager.getExecutionContext(workspaceId);
    if (
      !context ||
      context.workspaceId !== workspaceId ||
      typeof context.rootPath !== "string" ||
      context.rootPath.length === 0
    ) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace identity could not be verified.");
    }
    return { workspaceId, rootPath: context.rootPath };
  }

  #assertWorkspace(expected) {
    const current = this.#captureWorkspace(expected.workspaceId);
    if (current.rootPath !== expected.rootPath) {
      throw new WorkspaceError(
        "WORKSPACE_CHANGED",
        "The workspace changed before the search completed. Search the current folder again.",
      );
    }
  }

  #throwIfCancelled(job) {
    if (job.cancelled) throw cancelledError();
  }

  #jobKey(clientId, requestId) {
    return `${clientId}\0${requestId}`;
  }

  #timestamp() {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      throw new WorkspaceError("IO_ERROR", "The workspace search clock is invalid.");
    }
    return Math.trunc(value);
  }
}

module.exports = {
  WorkspaceSearchManager,
  DEFAULT_MAX_RESULTS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_OUTPUT_BYTES,
  MAX_QUERY_BYTES,
  MAX_RESULTS,
  MAX_TOTAL_BYTES,
  normalizeCancelRequest,
  normalizeSearchRequest,
};
