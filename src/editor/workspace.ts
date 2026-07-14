import type {
  CollabWorkspaceBridge,
  RawReadFileResult,
  RawResult,
  RawWorkspaceChangeEvent,
  RawWorkspaceCommandEvent,
  RawWorkspaceDescriptor,
  RawWorkspaceNode,
  RawWorkspaceTree,
} from "./bridge";
import { createDemoWorkspaceApi } from "./demoWorkspace";
import { WorkspaceError, toWorkspaceError } from "./errors";
import { detectLanguage } from "./languages";
import type {
  TextEncoding,
  WorkspaceApi,
  WorkspaceChangeEvent,
  WorkspaceCommandEvent,
  WorkspaceDescriptor,
  WorkspaceDirectoryNode,
  WorkspaceFile,
  WorkspaceFileNode,
  WorkspacePath,
  WorkspaceSaveResult,
  WorkspaceTree,
  WorkspaceTreeNode,
} from "./types";

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Validates and canonicalizes a path before it crosses the preload boundary. */
export function normalizeWorkspacePath(path: string, allowRoot = false): WorkspacePath {
  if (typeof path !== "string" || path.includes("\0")) {
    throw new WorkspaceError("invalid-path", "The workspace path is invalid.");
  }

  const slashPath = path.replace(/\\/g, "/");
  if (slashPath.startsWith("/") || /^[a-z]:\//i.test(slashPath)) {
    throw new WorkspaceError("invalid-path", "Workspace APIs only accept relative paths.", { path });
  }

  const segments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new WorkspaceError("invalid-path", "Workspace paths cannot leave the workspace root.", { path });
    }
    segments.push(segment);
  }

  const normalized = segments.join("/");
  if (!normalized && !allowRoot) {
    throw new WorkspaceError("invalid-path", "A file or folder path is required.", { path });
  }
  return normalized;
}

export function validateWorkspaceEntryName(name: string): string {
  const normalized = name.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    throw new WorkspaceError("invalid-path", "Enter a valid file or folder name.");
  }
  return normalized;
}

function normalizeDescriptor(raw: RawWorkspaceDescriptor): WorkspaceDescriptor {
  const rootPath = typeof raw.rootPath === "string"
    ? raw.rootPath
    : typeof raw.path === "string"
      ? raw.path
      : undefined;
  const inferredName = rootPath?.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : inferredName ?? "Workspace";
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : rootPath ?? name,
    name,
    ...(rootPath ? { rootPath } : {}),
    ...(typeof raw.readOnly === "boolean" ? { readOnly: raw.readOnly } : {}),
  };
}

function nodeKind(raw: RawWorkspaceNode): "file" | "directory" {
  if (raw.kind === "directory" || raw.type === "directory" || raw.type === "folder" || raw.isDirectory) {
    return "directory";
  }
  return "file";
}

function normalizeNode(raw: RawWorkspaceNode): WorkspaceTreeNode {
  const path = normalizeWorkspacePath(raw.path);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : baseName(path);
  const kind = nodeKind(raw);
  if (kind === "directory") {
    return {
      kind,
      path,
      name,
      children: (raw.children ?? []).map(normalizeNode),
      hidden: raw.ignored === true || name.startsWith("."),
    };
  }
  return {
    kind,
    path,
    name,
    ...(typeof raw.size === "number" ? { size: raw.size } : {}),
    ...(typeof raw.mtimeMs === "number" ? { mtimeMs: raw.mtimeMs } : {}),
    binary: raw.type === "symlink" || raw.binary === true,
    hidden: name.startsWith("."),
    language: detectLanguage(path),
  };
}

function normalizeTree(raw: RawWorkspaceTree): WorkspaceTree {
  let entries: RawWorkspaceNode[];
  if (Array.isArray(raw)) entries = raw;
  else if ("entries" in raw) entries = raw.entries;
  else if ("tree" in raw) entries = raw.tree;
  else if (nodeKind(raw) === "directory" && normalizeWorkspacePath(raw.path, true) === "") {
    entries = raw.children ?? [];
  } else entries = [raw];

  return entries.map(normalizeNode);
}

function unwrapResult<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

function normalizeEncoding(value: string | undefined): TextEncoding {
  if (value === "utf-16le" || value === "utf-16be") return value;
  return "utf-8";
}

function normalizeBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data) && data.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(data as number[]);
  }
  return undefined;
}

function normalizeReadResult(path: string, raw: RawReadFileResult): WorkspaceFile {
  if (typeof raw === "string") {
    return {
      kind: "text",
      path,
      name: baseName(path),
      content: raw,
      encoding: "utf-8",
      language: detectLanguage(path, raw),
      size: new TextEncoder().encode(raw).byteLength,
    };
  }

  const resolvedPath = raw.path ? normalizeWorkspacePath(raw.path) : path;
  const bytes = normalizeBytes(raw.data);
  if (raw.kind === "binary" || raw.binary === true || (bytes && raw.content === undefined)) {
    return {
      kind: "binary",
      path: resolvedPath,
      name: baseName(resolvedPath),
      ...(bytes ? { data: bytes } : {}),
      ...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}),
      ...(typeof raw.size === "number" ? { size: raw.size } : bytes ? { size: bytes.byteLength } : {}),
      ...(typeof raw.mtimeMs === "number" ? { mtimeMs: raw.mtimeMs } : {}),
    };
  }

  const content = typeof raw.content === "string" ? raw.content : "";
  return {
    kind: "text",
    path: resolvedPath,
    name: baseName(resolvedPath),
    content,
    encoding: normalizeEncoding(raw.encoding),
    language: detectLanguage(resolvedPath, content),
    ...(typeof raw.size === "number"
      ? { size: raw.size }
      : { size: new TextEncoder().encode(content).byteLength }),
    ...(typeof raw.mtimeMs === "number" ? { mtimeMs: raw.mtimeMs } : {}),
  };
}

function normalizeChangeEvent(raw: RawWorkspaceChangeEvent): WorkspaceChangeEvent {
  const rawKind = raw.kind ?? raw.type;
  const kind = rawKind === "add" || rawKind === "created"
    ? "created"
    : rawKind === "unlink" || rawKind === "deleted"
      ? "deleted"
      : rawKind === "rename" || rawKind === "renamed"
        ? "renamed"
        : rawKind === "workspace-opened"
          ? "workspace-opened"
          : "changed";
  return {
    kind,
    ...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}),
    ...(raw.path ? { path: normalizeWorkspacePath(raw.path) } : {}),
    ...(raw.oldPath ? { oldPath: normalizeWorkspacePath(raw.oldPath) } : {}),
    ...(raw.entry ? { entry: raw.entry } : {}),
    ...(typeof raw.mtimeMs === "number" ? { mtimeMs: raw.mtimeMs } : {}),
  };
}

function normalizeCommandEvent(raw: RawWorkspaceCommandEvent): WorkspaceCommandEvent {
  if (typeof raw === "string") return { command: raw };
  return {
    command: typeof raw.command === "string" ? raw.command : "unknown",
    ...(raw.path ? { path: normalizeWorkspacePath(raw.path) } : {}),
  };
}

function findNode(nodes: WorkspaceTree, path: string): WorkspaceTreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.kind === "directory") {
      const child = findNode(node.children, path);
      if (child) return child;
    }
  }
  return undefined;
}

export class ElectronWorkspaceApi implements WorkspaceApi {
  readonly source = "electron" as const;

  constructor(readonly bridge: CollabWorkspaceBridge) {}

  async openFolder(): Promise<WorkspaceDescriptor | null> {
    try {
      const raw = unwrapResult(await this.bridge.openFolder());
      return raw ? normalizeDescriptor(raw) : null;
    } catch (error) {
      throw toWorkspaceError(error, "Could not open the workspace folder.");
    }
  }

  async getCurrent(): Promise<WorkspaceDescriptor | null> {
    try {
      const raw = unwrapResult(await this.bridge.getCurrent());
      return raw ? normalizeDescriptor(raw) : null;
    } catch (error) {
      throw toWorkspaceError(error, "Could not read the current workspace.");
    }
  }

  async getTree(workspaceId?: string): Promise<WorkspaceTree> {
    try {
      return normalizeTree(unwrapResult(await this.bridge.getTree(workspaceId)));
    } catch (error) {
      throw toWorkspaceError(error, "Could not read the workspace files.");
    }
  }

  async readFile(inputPath: string, workspaceId?: string): Promise<WorkspaceFile> {
    const path = normalizeWorkspacePath(inputPath);
    try {
      const result = workspaceId === undefined
        ? await this.bridge.readFile(path)
        : await this.bridge.readFile(path, workspaceId);
      return normalizeReadResult(path, unwrapResult(result));
    } catch (error) {
      throw toWorkspaceError(error, `Could not read “${path}”.`, path);
    }
  }

  async saveFile(
    inputPath: string,
    content: string,
    expectedMtimeMs?: number,
    workspaceId?: string,
  ): Promise<WorkspaceSaveResult> {
    const path = normalizeWorkspacePath(inputPath);
    try {
      const raw = unwrapResult(await this.bridge.saveFile(path, content, expectedMtimeMs, workspaceId));
      return {
        path: raw?.path ? normalizeWorkspacePath(raw.path) : path,
        ...(typeof raw?.mtimeMs === "number" ? { mtimeMs: raw.mtimeMs } : {}),
        ...(typeof raw?.size === "number"
          ? { size: raw.size }
          : { size: new TextEncoder().encode(content).byteLength }),
      };
    } catch (error) {
      throw toWorkspaceError(error, `Could not save “${path}”.`, path);
    }
  }

  async createFile(inputParent: string, inputName: string, workspaceId?: string): Promise<WorkspaceFileNode> {
    const parent = normalizeWorkspacePath(inputParent, true);
    const name = validateWorkspaceEntryName(inputName);
    const path = joinPath(parent, name);
    try {
      const raw = unwrapResult(await this.bridge.createFile(parent, name, workspaceId));
      if (raw) {
        const node = normalizeNode(raw);
        if (node.kind !== "file") throw new WorkspaceError("io-error", "The new entry is not a file.", { path });
        return node;
      }
      return { kind: "file", path, name, language: detectLanguage(path) };
    } catch (error) {
      throw toWorkspaceError(error, `Could not create “${path}”.`, path);
    }
  }

  async createFolder(inputParent: string, inputName: string, workspaceId?: string): Promise<WorkspaceDirectoryNode> {
    const parent = normalizeWorkspacePath(inputParent, true);
    const name = validateWorkspaceEntryName(inputName);
    const path = joinPath(parent, name);
    try {
      const raw = unwrapResult(await this.bridge.createFolder(parent, name, workspaceId));
      if (raw) {
        const node = normalizeNode(raw);
        if (node.kind !== "directory") throw new WorkspaceError("io-error", "The new entry is not a folder.", { path });
        return node;
      }
      return { kind: "directory", path, name, children: [] };
    } catch (error) {
      throw toWorkspaceError(error, `Could not create “${path}”.`, path);
    }
  }

  async rename(inputPath: string, inputName: string, workspaceId?: string): Promise<WorkspaceTreeNode> {
    const path = normalizeWorkspacePath(inputPath);
    const newName = validateWorkspaceEntryName(inputName);
    const destination = joinPath(parentPath(path), newName);
    try {
      unwrapResult(await this.bridge.rename(path, newName, workspaceId));
      const node = findNode(await this.getTree(workspaceId), destination);
      if (!node) throw new WorkspaceError("not-found", `“${destination}” was not found after renaming.`, { path: destination });
      return node;
    } catch (error) {
      throw toWorkspaceError(error, `Could not rename “${path}”.`, path);
    }
  }

  async delete(inputPath: string, workspaceId?: string): Promise<void> {
    const path = normalizeWorkspacePath(inputPath);
    try {
      unwrapResult(await this.bridge.delete(path, workspaceId));
    } catch (error) {
      throw toWorkspaceError(error, `Could not delete “${path}”.`, path);
    }
  }

  onDidChange(callback: (event: WorkspaceChangeEvent) => void): () => void {
    const dispose = this.bridge.onDidChange((event) => {
      try {
        callback(normalizeChangeEvent(event));
      } catch {
        // Ignore malformed native events; the next tree refresh remains authoritative.
      }
    });
    return typeof dispose === "function" ? dispose : () => undefined;
  }

  onCommand(callback: (event: WorkspaceCommandEvent) => void): () => void {
    const dispose = this.bridge.onCommand((event) => {
      try {
        callback(normalizeCommandEvent(event));
      } catch {
        // Ignore malformed command payloads instead of breaking the editor event loop.
      }
    });
    return typeof dispose === "function" ? dispose : () => undefined;
  }
}

export function hasNativeWorkspaceBridge(): boolean {
  return typeof window !== "undefined" && typeof window.collabWorkspace?.getTree === "function";
}

export function createWorkspaceApi(bridge?: CollabWorkspaceBridge): WorkspaceApi {
  const nativeBridge = bridge ?? (typeof window !== "undefined" ? window.collabWorkspace : undefined);
  return nativeBridge ? new ElectronWorkspaceApi(nativeBridge) : createDemoWorkspaceApi();
}

/** Default singleton for the renderer. Tests can use createWorkspaceApi with a fake bridge. */
export const workspaceApi: WorkspaceApi = createWorkspaceApi();
