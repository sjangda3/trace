import type {
  WorkspaceChangeEvent,
  WorkspaceCommandEvent,
  WorkspaceDescriptor,
} from "./types";

export interface RawWorkspaceDescriptor extends Partial<WorkspaceDescriptor> {
  path?: string;
  tree?: RawWorkspaceNode[];
  treeTruncated?: boolean;
}

export interface RawWorkspaceNode {
  name?: string;
  path: string;
  kind?: "file" | "directory";
  type?: "file" | "directory" | "folder" | "symlink";
  isDirectory?: boolean;
  children?: RawWorkspaceNode[];
  size?: number;
  mtimeMs?: number;
  binary?: boolean;
  ignored?: boolean;
}

export type RawWorkspaceTree =
  | RawWorkspaceNode[]
  | RawWorkspaceNode
  | { entries: RawWorkspaceNode[] }
  | { tree: RawWorkspaceNode[]; truncated?: boolean };

export type RawFileData = Uint8Array | ArrayBuffer | number[];

export type RawReadFileResult =
  | string
  | {
      path?: string;
      content?: string;
      data?: RawFileData;
      kind?: "text" | "binary";
      binary?: boolean;
      encoding?: string;
      mimeType?: string;
      size?: number;
      mtimeMs?: number;
    };

export interface RawSaveFileResult {
  path?: string;
  size?: number;
  mtimeMs?: number;
}

export interface RawWorkspaceChangeEvent extends Partial<WorkspaceChangeEvent> {
  type?: string;
}

export type RawWorkspaceCommandEvent = string | Partial<WorkspaceCommandEvent>;

export type RawWorkspaceError = {
  code: string;
  message: string;
};

export type RawResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RawWorkspaceError };

/** The exact, context-isolated API exposed by Electron's preload script. */
export interface CollabWorkspaceBridge {
  openFolder(): Promise<RawResult<RawWorkspaceDescriptor | null>>;
  getCurrent(): Promise<RawResult<RawWorkspaceDescriptor | null>>;
  getTree(workspaceId?: string): Promise<RawResult<RawWorkspaceTree>>;
  readFile(path: string, workspaceId?: string): Promise<RawResult<RawReadFileResult>>;
  saveFile(path: string, content: string, expectedMtimeMs?: number, workspaceId?: string): Promise<RawResult<RawSaveFileResult>>;
  createFile(parentPath: string, name: string, workspaceId?: string): Promise<RawResult<RawWorkspaceNode>>;
  createFolder(parentPath: string, name: string, workspaceId?: string): Promise<RawResult<RawWorkspaceNode>>;
  rename(path: string, newName: string, workspaceId?: string): Promise<RawResult<{ oldPath: string; newPath: string }>>;
  delete(path: string, workspaceId?: string): Promise<RawResult<{ path: string }>>;
  onDidChange(callback: (event: RawWorkspaceChangeEvent) => void): (() => void) | void;
  onCommand(callback: (event: RawWorkspaceCommandEvent) => void): (() => void) | void;
}

declare global {
  interface Window {
    collabWorkspace?: CollabWorkspaceBridge;
  }
}
