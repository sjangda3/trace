/** The language identifiers used by the editor UI and syntax highlighter. */
export type EditorLanguageId =
  | "typescript"
  | "javascript"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "python"
  | "java"
  | "c"
  | "cpp"
  | "sql"
  | "go"
  | "yaml"
  | "shell"
  | "xml"
  | "rust"
  | "plaintext";

export interface LanguageDefinition {
  id: EditorLanguageId;
  label: string;
  extensions: readonly string[];
  filenames?: readonly string[];
  mimeType: string;
}

export type WorkspacePath = string;
export type WorkspaceId = string;
export type WorkspaceEntryKind = "file" | "directory";

export interface WorkspaceDescriptor {
  id: WorkspaceId;
  name: string;
  /** Absolute native path. It is display-only and never accepted by file APIs. */
  rootPath?: string;
  readOnly?: boolean;
}

interface WorkspaceTreeNodeBase {
  name: string;
  /** Slash-delimited path relative to the workspace root. */
  path: WorkspacePath;
  kind: WorkspaceEntryKind;
  hidden?: boolean;
}

export interface WorkspaceFileNode extends WorkspaceTreeNodeBase {
  kind: "file";
  size?: number;
  mtimeMs?: number;
  binary?: boolean;
  language?: EditorLanguageId;
}

export interface WorkspaceDirectoryNode extends WorkspaceTreeNodeBase {
  kind: "directory";
  children: WorkspaceTreeNode[];
}

export type WorkspaceTreeNode = WorkspaceFileNode | WorkspaceDirectoryNode;
export type WorkspaceTree = WorkspaceTreeNode[];

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be";

export interface WorkspaceTextFile {
  kind: "text";
  path: WorkspacePath;
  name: string;
  content: string;
  encoding: TextEncoding;
  language: EditorLanguageId;
  size?: number;
  mtimeMs?: number;
}

export interface WorkspaceBinaryFile {
  kind: "binary";
  path: WorkspacePath;
  name: string;
  data?: Uint8Array;
  mimeType?: string;
  size?: number;
  mtimeMs?: number;
}

export type WorkspaceFile = WorkspaceTextFile | WorkspaceBinaryFile;

export interface WorkspaceSaveResult {
  path: WorkspacePath;
  mtimeMs?: number;
  size?: number;
}

export type WorkspaceChangeKind =
  | "created"
  | "changed"
  | "renamed"
  | "deleted"
  | "workspace-opened";

export interface WorkspaceChangeEvent {
  kind: WorkspaceChangeKind;
  workspaceId?: WorkspaceId;
  path?: WorkspacePath;
  oldPath?: WorkspacePath;
  entry?: WorkspaceTreeNode;
  mtimeMs?: number;
}

export interface WorkspaceCommandEvent {
  command: string;
  path?: WorkspacePath;
}

export interface EditorSelection {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface EditorViewState {
  selection?: EditorSelection;
  scrollTop?: number;
  scrollLeft?: number;
}

export interface EditorTab {
  id: string;
  path: WorkspacePath;
  name: string;
  language: EditorLanguageId;
  isDirty: boolean;
  isPinned?: boolean;
  isPreview?: boolean;
  viewState?: EditorViewState;
}

export interface PersistedEditorTab {
  path: WorkspacePath;
  isPinned?: boolean;
  viewState?: EditorViewState;
}

export interface EditorSessionState {
  version: 1;
  workspaceId: WorkspaceId;
  openTabs: PersistedEditorTab[];
  activeFilePath: WorkspacePath | null;
}

export type WorkspaceErrorCode =
  | "not-available"
  | "cancelled"
  | "not-found"
  | "already-exists"
  | "permission-denied"
  | "invalid-path"
  | "is-directory"
  | "not-directory"
  | "binary-file"
  | "file-too-large"
  | "invalid-encoding"
  | "conflict"
  | "workspace-changed"
  | "io-error"
  | "unknown";

export interface WorkspaceApi {
  readonly source: "electron" | "demo";
  openFolder(): Promise<WorkspaceDescriptor | null>;
  getCurrent(): Promise<WorkspaceDescriptor | null>;
  getTree(workspaceId?: WorkspaceId): Promise<WorkspaceTree>;
  readFile(path: WorkspacePath, workspaceId?: WorkspaceId): Promise<WorkspaceFile>;
  saveFile(
    path: WorkspacePath,
    content: string,
    expectedMtimeMs?: number,
    workspaceId?: WorkspaceId,
  ): Promise<WorkspaceSaveResult>;
  createFile(parentPath: WorkspacePath, name: string, workspaceId?: WorkspaceId): Promise<WorkspaceFileNode>;
  createFolder(parentPath: WorkspacePath, name: string, workspaceId?: WorkspaceId): Promise<WorkspaceDirectoryNode>;
  rename(path: WorkspacePath, newName: string, workspaceId?: WorkspaceId): Promise<WorkspaceTreeNode>;
  delete(path: WorkspacePath, workspaceId?: WorkspaceId): Promise<void>;
  onDidChange(callback: (event: WorkspaceChangeEvent) => void): () => void;
  onCommand(callback: (event: WorkspaceCommandEvent) => void): () => void;
}
