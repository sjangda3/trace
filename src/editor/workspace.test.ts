import { describe, expect, it, vi } from "vitest";
import type {
  CollabWorkspaceBridge,
  RawResult,
  RawWorkspaceDescriptor,
} from "./bridge";
import { WorkspaceError } from "./errors";
import {
  ElectronWorkspaceApi,
  normalizeWorkspacePath,
  validateWorkspaceEntryName,
} from "./workspace";

function success<T>(value: T): RawResult<T> {
  return { ok: true, value };
}

function createBridge(overrides: Partial<CollabWorkspaceBridge> = {}): CollabWorkspaceBridge {
  return {
    openFolder: async () => success(null),
    getCurrent: async () => success(null),
    getTree: async () => success([]),
    readFile: async (path) => success({ path, content: "" }),
    saveFile: async (path, content) => success({ path, size: new TextEncoder().encode(content).byteLength }),
    createFile: async (parentPath, name) => success({
      path: parentPath ? `${parentPath}/${name}` : name,
      name,
      kind: "file",
    }),
    createFolder: async (parentPath, name) => success({
      path: parentPath ? `${parentPath}/${name}` : name,
      name,
      kind: "directory",
      children: [],
    }),
    rename: async (path, newName) => success({ oldPath: path, newPath: newName }),
    delete: async (path) => success({ path }),
    onDidChange: () => () => undefined,
    onCommand: () => () => undefined,
    ...overrides,
  };
}

function expectInvalidPath(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toMatchObject({ code: "invalid-path" });
    return;
  }
  throw new Error("Expected an invalid-path WorkspaceError.");
}

describe("workspace path validation", () => {
  it("canonicalizes safe relative paths", () => {
    expect(normalizeWorkspacePath("./src//editor\\workspace.ts")).toBe("src/editor/workspace.ts");
    expect(normalizeWorkspacePath("", true)).toBe("");
    expect(validateWorkspaceEntryName("  component.tsx  ")).toBe("component.tsx");
  });

  it.each(["", "/etc/passwd", "C:\\Windows\\system.ini", "../secret", "src/../../secret", "bad\0path"])(
    "rejects unsafe file path %j",
    (path) => expectInvalidPath(() => normalizeWorkspacePath(path)),
  );

  it.each(["", "   ", ".", "..", "nested/file.ts", "nested\\file.ts", "bad\0name"])(
    "rejects unsafe entry name %j",
    (name) => expectInvalidPath(() => validateWorkspaceEntryName(name)),
  );
});

describe("ElectronWorkspaceApi result handling", () => {
  it("unwraps successful Result values and normalizes native payloads", async () => {
    const descriptor: RawWorkspaceDescriptor = {
      path: "/Users/test/sample-project",
      readOnly: false,
    };
    const readFile = vi.fn(async () => success({
      path: "src/App.tsx",
      content: "export default function App() {}\n",
      encoding: "utf-8",
      mtimeMs: 42,
    }));
    const bridge = createBridge({
      getCurrent: async () => success(descriptor),
      getTree: async () => success({
        tree: [{
          path: "src",
          type: "directory",
          children: [{ path: "src/App.tsx", type: "file", size: 33 }],
        }],
      }),
      readFile,
    });
    const api = new ElectronWorkspaceApi(bridge);

    await expect(api.getCurrent()).resolves.toEqual({
      id: "/Users/test/sample-project",
      name: "sample-project",
      rootPath: "/Users/test/sample-project",
      readOnly: false,
    });
    await expect(api.getTree()).resolves.toMatchObject([{
      kind: "directory",
      path: "src",
      children: [{ kind: "file", path: "src/App.tsx", language: "typescript" }],
    }]);
    await expect(api.readFile("./src\\App.tsx")).resolves.toMatchObject({
      kind: "text",
      path: "src/App.tsx",
      language: "typescript",
      mtimeMs: 42,
    });
    expect(readFile).toHaveBeenCalledWith("src/App.tsx");
  });

  it("maps failed native Result values into stable renderer errors", async () => {
    const bridge = createBridge({
      readFile: async () => ({
        ok: false,
        error: { code: "NOT_FOUND", message: "The requested file no longer exists." },
      }),
      saveFile: async () => ({
        ok: false,
        error: { code: "CONFLICT", message: "The file changed on disk." },
      }),
    });
    const api = new ElectronWorkspaceApi(bridge);

    await expect(api.readFile("src/missing.ts")).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "not-found",
      path: "src/missing.ts",
      message: "The requested file no longer exists.",
    });
    await expect(api.saveFile("src/App.tsx", "changed", 10)).rejects.toMatchObject({
      name: "WorkspaceError",
      code: "conflict",
      path: "src/App.tsx",
      message: "The file changed on disk.",
    });
  });

  it("preserves an open-folder cancellation as a successful null result", async () => {
    const api = new ElectronWorkspaceApi(createBridge({ openFolder: async () => success(null) }));
    await expect(api.openFolder()).resolves.toBeNull();
  });
});
