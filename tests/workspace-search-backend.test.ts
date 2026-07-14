import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type SearchMatch = {
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  previewStartColumn: number;
};

type SearchResult = {
  workspaceId: string;
  requestId: string;
  query: string;
  files: Array<{ path: string; matches: SearchMatch[] }>;
  matchCount: number;
  filesScanned: number;
  filesSkipped: number;
  bytesScanned: number;
  truncated: boolean;
};

interface WorkspaceManagerInstance {
  openWorkspace(folderPath: string): Promise<{ id: string }>;
  getTree(workspaceId?: string): Promise<unknown>;
  getExecutionContext(workspaceId?: string): { workspaceId: string; rootPath: string };
  dispose(): void;
}

interface SearchManagerInstance {
  search(request: Record<string, unknown>, context?: { clientId?: string }): Promise<SearchResult>;
  cancel(request: Record<string, unknown>, context?: { clientId?: string }): {
    workspaceId: string;
    requestId: string;
    cancelled: boolean;
  };
  disposeWorkspace(workspaceId: string): void;
  disposeClient(clientId: string): void;
  dispose(): void;
}

const require = createRequire(import.meta.url);
const { WorkspaceManager } = require("../electron/workspace.cjs") as {
  WorkspaceManager: new (options: { settingsPath: string }) => WorkspaceManagerInstance;
};
const { WorkspaceSearchManager, MAX_FILE_BYTES } = require("../electron/workspace-search.cjs") as {
  WorkspaceSearchManager: new (options: { workspaceManager: WorkspaceManagerInstance }) => SearchManagerInstance;
  MAX_FILE_BYTES: number;
};

describe("WorkspaceSearchManager", () => {
  let sandboxPath: string;
  let workspacePath: string;
  let workspaceId: string;
  let workspace: WorkspaceManagerInstance;
  let search: SearchManagerInstance;

  beforeEach(async () => {
    sandboxPath = await mkdtemp(path.join(os.tmpdir(), "trace-search-test-"));
    workspacePath = path.join(sandboxPath, "workspace");
    await mkdir(workspacePath);
    workspace = new WorkspaceManager({ settingsPath: path.join(sandboxPath, "state.json") });
    workspaceId = (await workspace.openWorkspace(workspacePath)).id;
    search = new WorkspaceSearchManager({ workspaceManager: workspace });
  });

  afterEach(async () => {
    search.dispose();
    workspace.dispose();
    await rm(sandboxPath, { recursive: true, force: true });
  });

  it("finds literal text with stable UTF-16 editor coordinates and whole-word filtering", async () => {
    await mkdir(path.join(workspacePath, "src"));
    await writeFile(
      path.join(workspacePath, "src", "app.ts"),
      "Needle needle needles\r\nconst value = needle;\n",
    );

    const result = await search.search({
      workspaceId,
      requestId: "search-basic-0001",
      query: "needle",
      wholeWord: true,
    });

    expect(result).toMatchObject({ matchCount: 3, truncated: false, filesScanned: 1 });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: "src/app.ts" });
    expect(result.files[0].matches.map(({ line, column, endColumn }) => ({ line, column, endColumn }))).toEqual([
      { line: 1, column: 1, endColumn: 7 },
      { line: 1, column: 8, endColumn: 14 },
      { line: 2, column: 15, endColumn: 21 },
    ]);

    const exactCase = await search.search({
      workspaceId,
      requestId: "search-basic-0002",
      query: "Needle",
      caseSensitive: true,
    });
    expect(exactCase.matchCount).toBe(1);
  });

  it("skips ignored, binary, invalid UTF-8, oversized, and symlinked content", async () => {
    await writeFile(path.join(workspacePath, "visible.txt"), "find me safely\n");
    await writeFile(path.join(workspacePath, "binary.bin"), Buffer.from([0x66, 0x69, 0x00, 0x6e, 0x64]));
    await writeFile(path.join(workspacePath, "invalid.txt"), Buffer.from([0xc3, 0x28, 0x66, 0x69, 0x6e, 0x64]));
    await writeFile(path.join(workspacePath, "large.txt"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x66));
    await mkdir(path.join(workspacePath, "node_modules"));
    await writeFile(path.join(workspacePath, "node_modules", "secret.js"), "find hidden dependency\n");
    const outsidePath = path.join(sandboxPath, "outside.txt");
    await writeFile(outsidePath, "find outside\n");
    try {
      await symlink(outsidePath, path.join(workspacePath, "outside-link"), "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"].includes(code ?? "")) throw error;
    }

    const result = await search.search({
      workspaceId,
      requestId: "search-skips-0001",
      query: "find",
    });

    expect(result.matchCount).toBe(1);
    expect(result.files.map((file) => file.path)).toEqual(["visible.txt"]);
    expect(result.filesSkipped).toBeGreaterThanOrEqual(3);
    expect(result.bytesScanned).toBeLessThan(MAX_FILE_BYTES);
  });

  it("caps result output and reports truncation", async () => {
    await writeFile(path.join(workspacePath, "many.txt"), "hit hit hit hit\n");
    const result = await search.search({
      workspaceId,
      requestId: "search-limit-0001",
      query: "hit",
      maxResults: 2,
    });
    expect(result.matchCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("validates the complete request and binds searches to the active workspace", async () => {
    await writeFile(path.join(workspacePath, "source.txt"), "hello\n");
    await expect(search.search({
      workspaceId,
      requestId: "short",
      query: "hello",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(search.search({
      workspaceId,
      requestId: "search-invalid-0001",
      query: "hello\nworld",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(search.search({
      workspaceId,
      requestId: "search-invalid-0002",
      query: "hello",
      unexpected: true,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const secondWorkspace = path.join(sandboxPath, "second");
    await mkdir(secondWorkspace);
    await workspace.openWorkspace(secondWorkspace);
    await expect(search.search({
      workspaceId,
      requestId: "search-workspace-0001",
      query: "hello",
    })).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });
  });

  it("cancels by main-owned client identity without allowing another client to interfere", async () => {
    await writeFile(path.join(workspacePath, "source.txt"), "hello\n");
    const pending = search.search({
      workspaceId,
      requestId: "search-cancel-0001",
      query: "hello",
    }, { clientId: "window-a" });

    expect(search.cancel({
      workspaceId,
      requestId: "search-cancel-0001",
    }, { clientId: "window-b" }).cancelled).toBe(false);
    expect(search.cancel({
      workspaceId,
      requestId: "search-cancel-0001",
    }, { clientId: "window-a" }).cancelled).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "SEARCH_CANCELLED" });
  });

  it("rejects duplicate live request identities and permits reuse after cancellation", async () => {
    await writeFile(path.join(workspacePath, "source.txt"), "hello\n");
    const request = { workspaceId, requestId: "search-repeat-0001", query: "hello" };
    const first = search.search(request, { clientId: "window-a" });
    const firstCancellation = expect(first).rejects.toMatchObject({ code: "SEARCH_CANCELLED" });
    await expect(search.search(request, { clientId: "window-a" })).rejects.toMatchObject({
      code: "SEARCH_IN_PROGRESS",
    });
    search.cancel({ workspaceId, requestId: request.requestId }, { clientId: "window-a" });
    await firstCancellation;
    await expect(search.search(request, { clientId: "window-a" })).resolves.toMatchObject({
      matchCount: 1,
    });
  });
});
