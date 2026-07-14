const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");

const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_TREE_DEPTH = 64;
const WATCH_DEBOUNCE_MS = 90;

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".venv",
  "venv",
  "target",
  "out",
]);

const IGNORED_FILES = new Set([".DS_Store"]);

class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

function isWithin(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function toPortablePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function normalizeRelativePath(value, { allowRoot = true } = {}) {
  if (typeof value !== "string" || value.includes("\0") || path.isAbsolute(value)) {
    throw new WorkspaceError("INVALID_PATH", "A valid workspace-relative path is required.");
  }

  const normalized = path.normalize(value || ".");
  if (normalized === ".") {
    if (!allowRoot) throw new WorkspaceError("INVALID_PATH", "The workspace root cannot be changed.");
    return "";
  }

  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new WorkspaceError("OUTSIDE_WORKSPACE", "The path is outside the current workspace.");
  }

  return normalized;
}

function validateName(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    value.includes(path.sep) ||
    path.basename(value) !== value
  ) {
    throw new WorkspaceError("INVALID_NAME", "Enter a valid file or folder name.");
  }
  return value;
}

function mapNodeError(error) {
  if (error instanceof WorkspaceError) return error;

  switch (error?.code) {
    case "ENOENT":
      return new WorkspaceError("NOT_FOUND", "The file or folder no longer exists.");
    case "EEXIST":
      return new WorkspaceError("ALREADY_EXISTS", "A file or folder with that name already exists.");
    case "EACCES":
    case "EPERM":
      return new WorkspaceError("PERMISSION_DENIED", "Trace does not have permission to do that.");
    case "ENOTDIR":
      return new WorkspaceError("NOT_DIRECTORY", "The selected path is not a folder.");
    case "EISDIR":
      return new WorkspaceError("NOT_FILE", "The selected path is not a file.");
    default:
      return new WorkspaceError("IO_ERROR", "The workspace operation could not be completed.");
  }
}

function publicError(error) {
  const mapped = mapNodeError(error);
  return { code: mapped.code, message: mapped.message };
}

function success(value) {
  return { ok: true, value };
}

function failure(error) {
  return { ok: false, error: publicError(error) };
}

class WorkspaceManager {
  #rootPath = null;
  #workspaceId = null;
  #settingsPath;
  #watcher = null;
  #listeners = new Set();
  #pendingWatchChanges = new Map();
  #watchTimer = null;

  constructor({ settingsPath }) {
    this.#settingsPath = settingsPath;
  }

  get rootPath() {
    return this.#rootPath;
  }

  get workspaceId() {
    return this.#workspaceId;
  }

  getExecutionContext(expectedWorkspaceId) {
    this.#assertWorkspace(expectedWorkspaceId);
    return { workspaceId: this.#workspaceId, rootPath: this.#rootPath };
  }

  onDidChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async restoreLastWorkspace() {
    try {
      const raw = await fsp.readFile(this.#settingsPath, "utf8");
      const state = JSON.parse(raw);
      if (typeof state?.lastWorkspace !== "string") return null;
      return await this.openWorkspace(state.lastWorkspace, { remember: false, emit: false });
    } catch (error) {
      if (error?.code !== "ENOENT") console.warn("Could not restore the last workspace:", error?.message);
      return null;
    }
  }

  async openWorkspace(folderPath, { remember = true, emit = true } = {}) {
    if (typeof folderPath !== "string" || folderPath.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "A valid workspace folder is required.");
    }

    const canonicalPath = await fsp.realpath(path.resolve(folderPath));
    const stats = await fsp.stat(canonicalPath);
    if (!stats.isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "The selected path is not a folder.");

    const state = { count: 0, truncated: false };
    const tree = await this.#readDirectory(canonicalPath, "", 0, state);
    if (remember) await this.#rememberWorkspace(canonicalPath);

    const snapshot = {
      id: canonicalPath,
      rootPath: canonicalPath,
      name: path.basename(canonicalPath),
      tree,
      treeTruncated: state.truncated,
    };
    this.#rootPath = canonicalPath;
    this.#workspaceId = canonicalPath;
    this.#startWatcher();
    if (emit) this.#emit({ type: "workspace-opened", path: null, source: "workspace" });
    return snapshot;
  }

  async getSnapshot() {
    this.#requireWorkspace();
    const { tree, truncated } = await this.getTree();
    return {
      id: this.#workspaceId,
      rootPath: this.#rootPath,
      name: path.basename(this.#rootPath),
      tree,
      treeTruncated: truncated,
    };
  }

  async getTree(expectedWorkspaceId) {
    this.#requireWorkspace();
    this.#assertWorkspace(expectedWorkspaceId);
    const state = { count: 0, truncated: false };
    const tree = await this.#readDirectory(this.#rootPath, "", 0, state);
    return { tree, truncated: state.truncated };
  }

  async readTextFile(relativePath, expectedWorkspaceId) {
    this.#assertWorkspace(expectedWorkspaceId);
    const resolved = await this.#resolveExisting(relativePath, { allowRoot: false });
    if (!resolved.stats.isFile()) throw new WorkspaceError("NOT_FILE", "The selected path is not a file.");
    if (resolved.stats.size > MAX_TEXT_FILE_BYTES) {
      throw new WorkspaceError("FILE_TOO_LARGE", "Files larger than 10 MB cannot be opened in the editor.");
    }

    let handle;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      handle = await fsp.open(resolved.absolutePath, flags);
      const currentStats = await handle.stat();
      if (!currentStats.isFile()) throw new WorkspaceError("NOT_FILE", "The selected path is not a file.");
      if (currentStats.size > MAX_TEXT_FILE_BYTES) {
        throw new WorkspaceError("FILE_TOO_LARGE", "Files larger than 10 MB cannot be opened in the editor.");
      }

      const buffer = await handle.readFile();
      if (buffer.length > MAX_TEXT_FILE_BYTES) {
        throw new WorkspaceError("FILE_TOO_LARGE", "Files larger than 10 MB cannot be opened in the editor.");
      }
      if (buffer.includes(0)) throw new WorkspaceError("BINARY_FILE", "Binary files cannot be opened in the text editor.");

      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new WorkspaceError("INVALID_UTF8", "This file is not valid UTF-8 text.");
      }

      return {
        path: resolved.relativePath,
        content,
        size: buffer.length,
        mtimeMs: currentStats.mtimeMs,
      };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async saveTextFile(relativePath, content, expectedMtimeMs, expectedWorkspaceId) {
    this.#assertWorkspace(expectedWorkspaceId);
    if (typeof content !== "string") throw new WorkspaceError("INVALID_CONTENT", "File content must be text.");
    if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
      throw new WorkspaceError("FILE_TOO_LARGE", "Files larger than 10 MB cannot be saved in the editor.");
    }
    if (expectedMtimeMs !== undefined && expectedMtimeMs !== null && !Number.isFinite(expectedMtimeMs)) {
      throw new WorkspaceError("INVALID_REQUEST", "The save request is invalid.");
    }

    const lexical = this.#resolveLexical(relativePath, { allowRoot: false });
    const parent = await this.#resolveExisting(toPortablePath(path.dirname(lexical.relativePath)), { allowRoot: true });
    if (!parent.stats.isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "The parent path is not a folder.");

    let existingStats = null;
    try {
      const existing = await this.#resolveExisting(relativePath, { allowRoot: false });
      if (!existing.stats.isFile()) throw new WorkspaceError("NOT_FILE", "The selected path is not a file.");
      existingStats = existing.stats;
    } catch (error) {
      if (mapNodeError(error).code !== "NOT_FOUND") throw error;
    }

    if (expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
      if (!existingStats || Math.abs(existingStats.mtimeMs - expectedMtimeMs) > 0.5) {
        throw new WorkspaceError("CONFLICT", "The file changed on disk. Reload it before saving.");
      }
    }

    const tempName = `.trace-${crypto.randomUUID()}.tmp`;
    const tempPath = path.join(parent.absolutePath, tempName);
    const targetPath = path.join(parent.absolutePath, path.basename(lexical.absolutePath));
    const mode = existingStats ? existingStats.mode & 0o777 : 0o600;
    let handle;

    try {
      handle = await fsp.open(tempPath, "wx", mode);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;

      if (expectedMtimeMs !== undefined && expectedMtimeMs !== null) {
        let currentStats;
        try {
          currentStats = await fsp.lstat(targetPath);
        } catch (error) {
          if (error?.code === "ENOENT") {
            throw new WorkspaceError("CONFLICT", "The file changed on disk. Reload it before saving.");
          }
          throw error;
        }
        if (
          !existingStats ||
          currentStats.mtimeMs !== existingStats.mtimeMs ||
          currentStats.size !== existingStats.size ||
          currentStats.ino !== existingStats.ino ||
          currentStats.dev !== existingStats.dev
        ) {
          throw new WorkspaceError("CONFLICT", "The file changed on disk. Reload it before saving.");
        }
      }
      await fsp.rename(tempPath, targetPath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    const savedStats = await fsp.stat(targetPath);
    this.#emit({ type: existingStats ? "change" : "created", path: lexical.relativePath, source: "operation" });
    return { path: lexical.relativePath, size: savedStats.size, mtimeMs: savedStats.mtimeMs };
  }

  async createFile(parentPath, name, expectedWorkspaceId) {
    this.#assertWorkspace(expectedWorkspaceId);
    const parent = await this.#resolveExisting(parentPath, { allowRoot: true });
    if (!parent.stats.isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "The parent path is not a folder.");
    const childName = validateName(name);
    const absolutePath = path.join(parent.absolutePath, childName);
    const relativePath = toPortablePath(path.relative(this.#rootPath, absolutePath));
    const handle = await fsp.open(absolutePath, "wx", 0o600);
    await handle.close();
    const stats = await fsp.stat(absolutePath);
    this.#emit({ type: "created", path: relativePath, source: "operation" });
    return this.#fileNode(childName, relativePath, stats);
  }

  async createFolder(parentPath, name, expectedWorkspaceId) {
    this.#assertWorkspace(expectedWorkspaceId);
    const parent = await this.#resolveExisting(parentPath, { allowRoot: true });
    if (!parent.stats.isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "The parent path is not a folder.");
    const childName = validateName(name);
    const absolutePath = path.join(parent.absolutePath, childName);
    const relativePath = toPortablePath(path.relative(this.#rootPath, absolutePath));
    await fsp.mkdir(absolutePath, { mode: 0o700 });
    const stats = await fsp.stat(absolutePath);
    this.#emit({ type: "created", path: relativePath, source: "operation" });
    return this.#folderNode(childName, relativePath, stats, []);
  }

  async renameEntry(relativePath, newName, expectedWorkspaceId) {
    this.#assertWorkspace(expectedWorkspaceId);
    const source = await this.#resolveExisting(relativePath, { allowRoot: false, allowFinalSymlink: true });
    const childName = validateName(newName);
    const destinationPath = path.join(path.dirname(source.absolutePath), childName);
    if (!isWithin(this.#rootPath, destinationPath)) {
      throw new WorkspaceError("OUTSIDE_WORKSPACE", "The destination is outside the current workspace.");
    }

    try {
      await fsp.lstat(destinationPath);
      throw new WorkspaceError("ALREADY_EXISTS", "A file or folder with that name already exists.");
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }

    await fsp.rename(source.absolutePath, destinationPath);
    const newPath = toPortablePath(path.relative(this.#rootPath, destinationPath));
    this.#emit({ type: "renamed", path: newPath, oldPath: source.relativePath, source: "operation" });
    return { oldPath: source.relativePath, newPath };
  }

  async deleteEntry(relativePath, expectedWorkspaceId) {
    this.#assertWorkspace(expectedWorkspaceId);
    const target = await this.#resolveExisting(relativePath, { allowRoot: false, allowFinalSymlink: true });
    await fsp.rm(target.absolutePath, { recursive: target.stats.isDirectory(), force: false });
    this.#emit({ type: "deleted", path: target.relativePath, source: "operation" });
    return { path: target.relativePath };
  }

  dispose() {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = null;
    this.#pendingWatchChanges.clear();
    this.#listeners.clear();
  }

  #requireWorkspace() {
    if (!this.#rootPath) throw new WorkspaceError("NO_WORKSPACE", "Open a folder to start editing.");
  }

  #assertWorkspace(expectedWorkspaceId) {
    this.#requireWorkspace();
    if (expectedWorkspaceId !== undefined && expectedWorkspaceId !== this.#workspaceId) {
      throw new WorkspaceError(
        "WORKSPACE_CHANGED",
        "The workspace changed before the operation completed. Try again in the current folder.",
      );
    }
  }

  #resolveLexical(relativePath, { allowRoot = true } = {}) {
    this.#requireWorkspace();
    const normalized = normalizeRelativePath(relativePath, { allowRoot });
    const absolutePath = path.resolve(this.#rootPath, normalized);
    if (!isWithin(this.#rootPath, absolutePath)) {
      throw new WorkspaceError("OUTSIDE_WORKSPACE", "The path is outside the current workspace.");
    }
    return { absolutePath, relativePath: toPortablePath(normalized) };
  }

  async #resolveExisting(relativePath, { allowRoot = true, allowFinalSymlink = false } = {}) {
    const lexical = this.#resolveLexical(relativePath, { allowRoot });
    let stats;
    try {
      stats = await fsp.lstat(lexical.absolutePath);
    } catch (error) {
      throw mapNodeError(error);
    }

    if (stats.isSymbolicLink()) {
      if (!allowFinalSymlink) {
        throw new WorkspaceError("SYMLINK_NOT_ALLOWED", "Symbolic links cannot be opened or modified as files.");
      }
      const canonicalParent = await fsp.realpath(path.dirname(lexical.absolutePath));
      if (!isWithin(this.#rootPath, canonicalParent)) {
        throw new WorkspaceError("OUTSIDE_WORKSPACE", "The path resolves outside the current workspace.");
      }
      return { ...lexical, stats };
    }

    const canonicalPath = await fsp.realpath(lexical.absolutePath);
    if (!isWithin(this.#rootPath, canonicalPath)) {
      throw new WorkspaceError("OUTSIDE_WORKSPACE", "The path resolves outside the current workspace.");
    }
    return { absolutePath: canonicalPath, relativePath: lexical.relativePath, stats };
  }

  async #readDirectory(absoluteDirectory, relativeDirectory, depth, state) {
    if (depth > MAX_TREE_DEPTH || state.count >= MAX_TREE_ENTRIES) {
      state.truncated = true;
      return [];
    }

    let entries;
    try {
      entries = await fsp.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "EACCES" || error?.code === "EPERM") return [];
      throw error;
    }

    entries.sort((left, right) => {
      const leftFolder = left.isDirectory() && !left.isSymbolicLink();
      const rightFolder = right.isDirectory() && !right.isSymbolicLink();
      if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
    });

    const nodes = [];
    for (const entry of entries) {
      if (state.count >= MAX_TREE_ENTRIES) {
        state.truncated = true;
        break;
      }
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isFile() && IGNORED_FILES.has(entry.name)) continue;

      const absolutePath = path.join(absoluteDirectory, entry.name);
      const relativePath = toPortablePath(path.join(relativeDirectory, entry.name));
      let stats;
      try {
        stats = await fsp.lstat(absolutePath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }

      state.count += 1;
      if (stats.isSymbolicLink()) {
        nodes.push({ name: entry.name, path: relativePath, type: "symlink", size: stats.size, mtimeMs: stats.mtimeMs });
      } else if (stats.isDirectory()) {
        const ignored = entry.name === ".git";
        const children = ignored ? [] : await this.#readDirectory(absolutePath, relativePath, depth + 1, state);
        nodes.push({ ...this.#folderNode(entry.name, relativePath, stats, children), ignored });
      } else if (stats.isFile()) {
        nodes.push(this.#fileNode(entry.name, relativePath, stats));
      }
    }
    return nodes;
  }

  #fileNode(name, relativePath, stats) {
    return { name, path: relativePath, type: "file", size: stats.size, mtimeMs: stats.mtimeMs };
  }

  #folderNode(name, relativePath, stats, children) {
    return { name, path: relativePath, type: "folder", mtimeMs: stats.mtimeMs, children };
  }

  async #rememberWorkspace(rootPath) {
    await fsp.mkdir(path.dirname(this.#settingsPath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.#settingsPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tempPath, JSON.stringify({ lastWorkspace: rootPath }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fsp.rename(tempPath, this.#settingsPath);
    } catch (error) {
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  #startWatcher() {
    this.#watcher?.close();
    this.#watcher = null;
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#pendingWatchChanges.clear();

    try {
      this.#watcher = fs.watch(
        this.#rootPath,
        { recursive: process.platform === "darwin", persistent: false },
        (eventType, filename) => this.#queueWatchChange(eventType, filename),
      );
      this.#watcher.on("error", () => {
        this.#emit({ type: "watch-error", path: null, source: "watch" });
      });
    } catch {
      this.#emit({ type: "watch-error", path: null, source: "watch" });
    }
  }

  #queueWatchChange(eventType, filename) {
    if (!filename) return;
    const rawPath = Buffer.isBuffer(filename) ? filename.toString("utf8") : String(filename);
    if (!rawPath || rawPath.includes("\0") || (rawPath.includes(".trace-") && rawPath.endsWith(".tmp"))) return;
    const normalized = path.normalize(rawPath);
    if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) return;
    const segments = normalized.split(path.sep);
    if (
      segments.some((segment) => IGNORED_DIRECTORIES.has(segment)) ||
      segments[0] === ".git" ||
      IGNORED_FILES.has(segments.at(-1))
    ) return;

    const portablePath = toPortablePath(normalized);
    this.#pendingWatchChanges.set(portablePath, eventType === "rename" ? "renamed" : "change");
    if (this.#watchTimer) clearTimeout(this.#watchTimer);
    this.#watchTimer = setTimeout(() => void this.#flushWatchChanges(), WATCH_DEBOUNCE_MS);
  }

  async #flushWatchChanges() {
    this.#watchTimer = null;
    const changes = [...this.#pendingWatchChanges.entries()];
    this.#pendingWatchChanges.clear();
    for (const [changedPath, queuedType] of changes) {
      let type = queuedType;
      const absolutePath = path.resolve(this.#rootPath, changedPath);
      try {
        await fsp.lstat(absolutePath);
        if (queuedType === "renamed") type = "created";
      } catch (error) {
        if (error?.code === "ENOENT") type = "deleted";
        else continue;
      }
      this.#emit({ type, path: changedPath, source: "watch" });
    }
  }

  #emit(change) {
    const event = { ...change, workspaceId: this.#workspaceId, timestamp: Date.now() };
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Workspace change listener failed:", error);
      }
    }
  }
}

module.exports = {
  WorkspaceError,
  WorkspaceManager,
  failure,
  success,
};
