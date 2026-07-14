import { WorkspaceError } from "./errors";
import { detectLanguage } from "./languages";
import type {
  WorkspaceApi,
  WorkspaceChangeEvent,
  WorkspaceCommandEvent,
  WorkspaceDescriptor,
  WorkspaceDirectoryNode,
  WorkspaceFile,
  WorkspaceFileNode,
  WorkspaceSaveResult,
  WorkspaceTree,
  WorkspaceTreeNode,
} from "./types";

interface DemoEntry {
  kind: "file" | "directory";
  content?: string;
  data?: Uint8Array;
  mtimeMs: number;
}

const DEMO_FILES: Readonly<Record<string, string>> = {
  ".collab/workspace.json": "{\n  \"workspace\": \"trace\"\n}\n",
  ".git/HEAD": "ref: refs/heads/main\n",
  "apps/desktop/electron/main.cjs": `const { app, BrowserWindow } = require("electron");\n\napp.whenReady().then(() => {\n  new BrowserWindow({ width: 1250, height: 727 });\n});\n`,
  "apps/desktop/src/components/collaboration/annotation-thread.tsx": `export function AnnotationThread() {\n  return <aside aria-label="Code annotations" />;\n}\n`,
  "apps/desktop/src/components/collaboration/presence-cursors.tsx": `export function PresenceCursors() {\n  return null;\n}\n`,
  "apps/desktop/src/components/collaboration/terminal-control.tsx": `export type TerminalControl = {\n  ownerId: string | null;\n  lastInputAt: number;\n};\n`,
  "apps/desktop/src/components/workspace-shell.tsx": `"use client";\n\nimport { useMemo, useState } from "react";\nimport { cn } from "@/lib/utils";\nimport { ProjectMap } from "./project-map";\n\ntype WorkspaceShellProps = {\n  workspaceId: string;\n  initialRepository: Repository;\n  collaborators: Collaborator[];\n};\n\nexport function WorkspaceShell({\n  workspaceId,\n  initialRepository,\n  collaborators,\n}: WorkspaceShellProps) {\n  const [activePanel, setActivePanel] = useState("files");\n  const [selectedFile, setSelectedFile] = useState("workspace-shell.tsx");\n\n  const onlineMembers = useMemo(\n    () => collaborators.filter((member) => member.online),\n    [collaborators],\n  );\n\n  return (\n    <main className="workspace-shell">\n      <WorkspaceSidebar\n        repository={initialRepository}\n        selectedFile={selectedFile}\n        onSelectFile={setSelectedFile}\n      />\n      <EditorSurface workspaceId={workspaceId} />\n      <ProjectMap members={onlineMembers} />\n    </main>\n  );\n}\n`,
  "apps/desktop/src/components/project-map.tsx": `export function ProjectMap({ members }: { members: Collaborator[] }) {\n  return <aside data-members={members.length} />;\n}\n`,
  "apps/desktop/src/sync/workspace-state.ts": `export type WorkspaceState = {\n  activeFile: string | null;\n  connected: boolean;\n  pendingChanges: number;\n};\n`,
  "apps/desktop/package.json": "{\n  \"name\": \"@trace/desktop\",\n  \"private\": true\n}\n",
  "apps/product-spec.md": "# Trace Product Spec\n\nA collaboration-first desktop IDE for small teams.\n",
  "README.md": "# Trace\n\nA collaboration-first desktop IDE.\n",
};

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function nowAfter(previous?: number): number {
  return Math.max(Date.now(), (previous ?? 0) + 1);
}

export class DemoWorkspaceApi implements WorkspaceApi {
  readonly source = "demo" as const;
  readonly #descriptor: WorkspaceDescriptor = {
    id: "browser-demo",
    name: "trace",
  };
  readonly #entries = new Map<string, DemoEntry>();
  readonly #changeListeners = new Set<(event: WorkspaceChangeEvent) => void>();
  readonly #commandListeners = new Set<(event: WorkspaceCommandEvent) => void>();

  constructor(files: Readonly<Record<string, string>> = DEMO_FILES) {
    const initialTime = Date.now();
    this.#entries.set("", { kind: "directory", mtimeMs: initialTime });

    for (const [path, content] of Object.entries(files)) {
      const segments = path.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const directory = segments.slice(0, index).join("/");
        if (!this.#entries.has(directory)) {
          this.#entries.set(directory, { kind: "directory", mtimeMs: initialTime });
        }
      }
      this.#entries.set(path, { kind: "file", content, mtimeMs: initialTime });
    }
  }

  async openFolder(): Promise<WorkspaceDescriptor> {
    this.#emit({ kind: "workspace-opened" });
    return this.#descriptor;
  }

  async getCurrent(): Promise<WorkspaceDescriptor> {
    return this.#descriptor;
  }

  async getTree(): Promise<WorkspaceTree> {
    return this.#childrenOf("");
  }

  async readFile(path: string): Promise<WorkspaceFile> {
    const entry = this.#requireEntry(path);
    if (entry.kind === "directory") {
      throw new WorkspaceError("is-directory", `“${path}” is a directory.`, { path });
    }
    if (entry.data) {
      return {
        kind: "binary",
        path,
        name: baseName(path),
        data: entry.data.slice(),
        size: entry.data.byteLength,
        mtimeMs: entry.mtimeMs,
      };
    }
    const content = entry.content ?? "";
    return {
      kind: "text",
      path,
      name: baseName(path),
      content,
      encoding: "utf-8",
      language: detectLanguage(path, content),
      size: new TextEncoder().encode(content).byteLength,
      mtimeMs: entry.mtimeMs,
    };
  }

  async saveFile(path: string, content: string, expectedMtimeMs?: number): Promise<WorkspaceSaveResult> {
    const entry = this.#requireEntry(path);
    if (entry.kind === "directory") {
      throw new WorkspaceError("is-directory", `“${path}” is a directory.`, { path });
    }
    if (expectedMtimeMs !== undefined && entry.mtimeMs !== expectedMtimeMs) {
      throw new WorkspaceError("conflict", `“${path}” changed on disk.`, { path });
    }
    entry.content = content;
    entry.data = undefined;
    entry.mtimeMs = nowAfter(entry.mtimeMs);
    const size = new TextEncoder().encode(content).byteLength;
    this.#emit({ kind: "changed", path, mtimeMs: entry.mtimeMs });
    return { path, size, mtimeMs: entry.mtimeMs };
  }

  async createFile(parent: string, name: string): Promise<WorkspaceFileNode> {
    this.#requireDirectory(parent);
    const path = joinPath(parent, name);
    this.#requireMissing(path);
    const mtimeMs = Date.now();
    this.#entries.set(path, { kind: "file", content: "", mtimeMs });
    const node = this.#nodeAt(path) as WorkspaceFileNode;
    this.#emit({ kind: "created", path, entry: node });
    return node;
  }

  async createFolder(parent: string, name: string): Promise<WorkspaceDirectoryNode> {
    this.#requireDirectory(parent);
    const path = joinPath(parent, name);
    this.#requireMissing(path);
    this.#entries.set(path, { kind: "directory", mtimeMs: Date.now() });
    const node = this.#nodeAt(path) as WorkspaceDirectoryNode;
    this.#emit({ kind: "created", path, entry: node });
    return node;
  }

  async rename(path: string, newName: string): Promise<WorkspaceTreeNode> {
    this.#requireEntry(path);
    const destination = joinPath(parentPath(path), newName);
    this.#requireMissing(destination);

    const moves = [...this.#entries.entries()]
      .filter(([candidate]) => candidate === path || candidate.startsWith(`${path}/`))
      .map(([oldPath, entry]) => [
        oldPath,
        oldPath === path ? destination : `${destination}${oldPath.slice(path.length)}`,
        entry,
      ] as const);

    for (const [oldPath] of moves) this.#entries.delete(oldPath);
    for (const [, newPath, entry] of moves) this.#entries.set(newPath, entry);

    const node = this.#nodeAt(destination);
    this.#emit({ kind: "renamed", path: destination, oldPath: path, entry: node });
    return node;
  }

  async delete(path: string): Promise<void> {
    if (!path) throw new WorkspaceError("permission-denied", "The workspace root cannot be deleted.");
    this.#requireEntry(path);
    for (const candidate of [...this.#entries.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.#entries.delete(candidate);
    }
    this.#emit({ kind: "deleted", path });
  }

  onDidChange(callback: (event: WorkspaceChangeEvent) => void): () => void {
    this.#changeListeners.add(callback);
    return () => this.#changeListeners.delete(callback);
  }

  onCommand(callback: (event: WorkspaceCommandEvent) => void): () => void {
    this.#commandListeners.add(callback);
    return () => this.#commandListeners.delete(callback);
  }

  #requireEntry(path: string): DemoEntry {
    const entry = this.#entries.get(path);
    if (!entry) throw new WorkspaceError("not-found", `“${path}” does not exist.`, { path });
    return entry;
  }

  #requireDirectory(path: string): void {
    const entry = this.#requireEntry(path);
    if (entry.kind !== "directory") {
      throw new WorkspaceError("not-directory", `“${path}” is not a directory.`, { path });
    }
  }

  #requireMissing(path: string): void {
    if (this.#entries.has(path)) {
      throw new WorkspaceError("already-exists", `“${path}” already exists.`, { path });
    }
  }

  #childrenOf(parent: string): WorkspaceTree {
    const children: WorkspaceTree = [];
    for (const path of this.#entries.keys()) {
      if (path && parentPath(path) === parent) children.push(this.#nodeAt(path));
    }
    return children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }

  #nodeAt(path: string): WorkspaceTreeNode {
    const entry = this.#requireEntry(path);
    const common = { path, name: baseName(path) };
    if (entry.kind === "directory") {
      return { ...common, kind: "directory", children: this.#childrenOf(path) };
    }
    const size = entry.data?.byteLength ?? new TextEncoder().encode(entry.content ?? "").byteLength;
    return {
      ...common,
      kind: "file",
      size,
      mtimeMs: entry.mtimeMs,
      binary: Boolean(entry.data),
      language: detectLanguage(path, entry.content),
    };
  }

  #emit(event: WorkspaceChangeEvent): void {
    for (const listener of this.#changeListeners) listener(event);
  }
}

export function createDemoWorkspaceApi(files?: Readonly<Record<string, string>>): WorkspaceApi {
  return new DemoWorkspaceApi(files);
}
