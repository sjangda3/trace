import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

interface WorkspaceNode {
  name: string;
  path: string;
  type: "file" | "folder" | "symlink";
  ignored?: boolean;
  children?: WorkspaceNode[];
}

interface WorkspaceManagerInstance {
  readonly rootPath: string | null;
  openWorkspace(folderPath: string): Promise<{
    id: string;
    rootPath: string;
    name: string;
    tree: WorkspaceNode[];
    treeTruncated: boolean;
  }>;
  restoreLastWorkspace(): Promise<unknown>;
  getTree(expectedWorkspaceId?: string): Promise<{ tree: WorkspaceNode[]; truncated: boolean }>;
  readTextFile(relativePath: string, expectedWorkspaceId?: string): Promise<{
    path: string;
    content: string;
    size: number;
    mtimeMs: number;
  }>;
  saveTextFile(relativePath: string, content: string, expectedMtimeMs?: number): Promise<{
    path: string;
    size: number;
    mtimeMs: number;
  }>;
  createFile(parentPath: string, name: string): Promise<WorkspaceNode>;
  createFolder(parentPath: string, name: string): Promise<WorkspaceNode>;
  renameEntry(relativePath: string, newName: string): Promise<{ oldPath: string; newPath: string }>;
  deleteEntry(relativePath: string): Promise<{ path: string }>;
  dispose(): void;
}

const require = createRequire(import.meta.url);
const { WorkspaceManager } = require("../electron/workspace.cjs") as {
  WorkspaceManager: new (options: { settingsPath: string }) => WorkspaceManagerInstance;
};

describe("WorkspaceManager backend", () => {
  let sandboxPath: string;
  let workspacePath: string;
  let settingsPath: string;
  let manager: WorkspaceManagerInstance;
  const managers = new Set<WorkspaceManagerInstance>();

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(os.tmpdir(), "trace-workspace-test-"));
    workspacePath = path.join(sandboxPath, "workspace");
    settingsPath = path.join(sandboxPath, "state", "workspace.json");
    await mkdir(workspacePath);
    manager = new WorkspaceManager({ settingsPath });
    managers.add(manager);
  });

  afterEach(async () => {
    for (const activeManager of managers) activeManager.dispose();
    managers.clear();
    await rm(sandboxPath, { recursive: true, force: true });
  });

  it("filters heavy directories while supporting recursive tree, text reads, and saves", async () => {
    await writeFile(path.join(workspacePath, "hello.ts"), "export const hello = true;\n");
    await mkdir(path.join(workspacePath, "src"));
    await writeFile(path.join(workspacePath, "src", "nested.ts"), "export {};\n");
    await mkdir(path.join(workspacePath, "node_modules"));
    await writeFile(path.join(workspacePath, "node_modules", "hidden.js"), "hidden");
    await mkdir(path.join(workspacePath, "dist"));
    await writeFile(path.join(workspacePath, "dist", "bundle.js"), "generated");
    await mkdir(path.join(workspacePath, ".git"));
    await writeFile(path.join(workspacePath, ".git", "config"), "private internals");

    const snapshot = await manager.openWorkspace(workspacePath);
    expect(snapshot.rootPath).toBe(await realpath(workspacePath));
    expect(snapshot.treeTruncated).toBe(false);
    expect(snapshot.tree.map((node) => node.name)).not.toContain("node_modules");
    expect(snapshot.tree.map((node) => node.name)).not.toContain("dist");
    expect(snapshot.tree.find((node) => node.name === ".git")).toMatchObject({
      type: "folder",
      ignored: true,
      children: [],
    });
    expect(snapshot.tree.find((node) => node.name === "src")?.children).toEqual([
      expect.objectContaining({ name: "nested.ts", path: "src/nested.ts", type: "file" }),
    ]);

    const opened = await manager.readTextFile("hello.ts");
    expect(opened).toMatchObject({
      path: "hello.ts",
      content: "export const hello = true;\n",
    });

    const saved = await manager.saveTextFile(
      "hello.ts",
      "export const hello = false;\n",
      opened.mtimeMs,
    );
    expect(saved.path).toBe("hello.ts");
    await expect(manager.readTextFile("hello.ts")).resolves.toMatchObject({
      content: "export const hello = false;\n",
    });
  });

  it("rejects stale writes with a conflict error", async () => {
    const filePath = path.join(workspacePath, "conflict.ts");
    await writeFile(filePath, "const version = 1;\n");
    await manager.openWorkspace(workspacePath);
    const opened = await manager.readTextFile("conflict.ts");

    await writeFile(filePath, "const version = 2;\n");
    const externallyChangedTime = new Date(opened.mtimeMs + 5_000);
    await utimes(filePath, externallyChangedTime, externallyChangedTime);

    await expect(
      manager.saveTextFile("conflict.ts", "const version = 3;\n", opened.mtimeMs),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("creates, renames, and deletes files and folders", async () => {
    await manager.openWorkspace(workspacePath);

    await expect(manager.createFolder("", "src")).resolves.toMatchObject({
      path: "src",
      type: "folder",
    });
    await expect(manager.createFile("src", "index.ts")).resolves.toMatchObject({
      path: "src/index.ts",
      type: "file",
    });
    await expect(manager.renameEntry("src/index.ts", "main.ts")).resolves.toEqual({
      oldPath: "src/index.ts",
      newPath: "src/main.ts",
    });
    await expect(access(path.join(workspacePath, "src", "main.ts"))).resolves.toBeUndefined();
    await expect(access(path.join(workspacePath, "src", "index.ts"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(manager.deleteEntry("src/main.ts")).resolves.toEqual({ path: "src/main.ts" });
    await expect(manager.deleteEntry("src")).resolves.toEqual({ path: "src" });
    await expect(access(path.join(workspacePath, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects paths that attempt to leave the workspace", async () => {
    await writeFile(path.join(sandboxPath, "outside.txt"), "secret");
    await manager.openWorkspace(workspacePath);

    await expect(manager.readTextFile("../outside.txt")).rejects.toMatchObject({
      code: "OUTSIDE_WORKSPACE",
    });
  });

  it("does not follow file symlinks when the platform supports them", async () => {
    const outsidePath = path.join(sandboxPath, "outside.txt");
    const linkPath = path.join(workspacePath, "outside-link");
    await writeFile(outsidePath, "secret");

    try {
      await symlink(outsidePath, linkPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"].includes(code ?? "")) return;
      throw error;
    }

    await manager.openWorkspace(workspacePath);
    await expect(manager.readTextFile("outside-link")).rejects.toMatchObject({
      code: "SYMLINK_NOT_ALLOWED",
    });
  });

  it("restores the last successfully opened workspace", async () => {
    await writeFile(path.join(workspacePath, "README.md"), "# Workspace\n");
    await manager.openWorkspace(workspacePath);
    manager.dispose();
    managers.delete(manager);

    const restoredManager = new WorkspaceManager({ settingsPath });
    managers.add(restoredManager);
    await restoredManager.restoreLastWorkspace();

    expect(restoredManager.rootPath).toBe(await realpath(workspacePath));
    await expect(restoredManager.getTree()).resolves.toMatchObject({
      truncated: false,
      tree: [expect.objectContaining({ name: "README.md", path: "README.md", type: "file" })],
    });
  });

  it("rejects an operation bound to a workspace that has since been replaced", async () => {
    const secondWorkspacePath = path.join(sandboxPath, "second-workspace");
    await mkdir(secondWorkspacePath);
    await writeFile(path.join(workspacePath, "same-name.txt"), "first");
    await writeFile(path.join(secondWorkspacePath, "same-name.txt"), "second");

    const firstWorkspace = await manager.openWorkspace(workspacePath);
    const secondWorkspace = await manager.openWorkspace(secondWorkspacePath);

    await expect(
      manager.readTextFile("same-name.txt", firstWorkspace.id),
    ).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
    await expect(
      manager.readTextFile("same-name.txt", secondWorkspace.id),
    ).resolves.toMatchObject({ content: "second" });
  });
});
