import { describe, expect, it } from "vitest";
import {
  clearEditorSession,
  createEmptyEditorSession,
  editorSessionStorageKey,
  loadEditorSession,
  saveEditorSession,
  type StorageLike,
} from "./persistence";
import type { EditorSessionState } from "./types";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("editor session persistence", () => {
  it("round-trips open tabs, the active file, and view state per workspace", () => {
    const storage = new MemoryStorage();
    const session: EditorSessionState = {
      version: 1,
      workspaceId: "workspace:/sample",
      activeFilePath: "src/App.tsx",
      openTabs: [
        {
          path: "src/App.tsx",
          isPinned: true,
          viewState: {
            scrollTop: 120,
            scrollLeft: 4,
            selection: {
              startLineNumber: 8,
              startColumn: 3,
              endLineNumber: 8,
              endColumn: 12,
            },
          },
        },
        { path: "README.md" },
      ],
    };

    expect(saveEditorSession(session, storage)).toBe(true);
    expect(loadEditorSession(session.workspaceId, storage)).toEqual(session);
    expect(editorSessionStorageKey(session.workspaceId)).toContain(encodeURIComponent(session.workspaceId));
  });

  it("returns an empty session for corrupted, stale, or cross-workspace data", () => {
    const storage = new MemoryStorage();
    const workspaceId = "current-workspace";
    const key = editorSessionStorageKey(workspaceId);

    storage.setItem(key, "{ definitely not json");
    expect(loadEditorSession(workspaceId, storage)).toEqual(createEmptyEditorSession(workspaceId));

    storage.setItem(key, JSON.stringify({
      version: 1,
      workspaceId: "different-workspace",
      openTabs: [{ path: "secrets.txt" }],
      activeFilePath: "secrets.txt",
    }));
    expect(loadEditorSession(workspaceId, storage)).toEqual(createEmptyEditorSession(workspaceId));

    storage.setItem(key, JSON.stringify({ version: 0, workspaceId, openTabs: [] }));
    expect(loadEditorSession(workspaceId, storage)).toEqual(createEmptyEditorSession(workspaceId));
  });

  it("sanitizes duplicate tabs and repairs an invalid active file", () => {
    const storage = new MemoryStorage();
    const workspaceId = "workspace-1";
    storage.setItem(editorSessionStorageKey(workspaceId), JSON.stringify({
      version: 1,
      workspaceId,
      openTabs: [
        { path: "src/first.ts", isPinned: true },
        { path: "src/first.ts" },
        { path: 42 },
        { path: "src/second.ts", viewState: { scrollTop: -1 } },
      ],
      activeFilePath: "src/not-open.ts",
    }));

    expect(loadEditorSession(workspaceId, storage)).toEqual({
      version: 1,
      workspaceId,
      openTabs: [
        { path: "src/first.ts", isPinned: true },
        { path: "src/second.ts" },
      ],
      activeFilePath: "src/first.ts",
    });
  });

  it("clears a saved session and degrades safely when storage throws", () => {
    const storage = new MemoryStorage();
    const session = createEmptyEditorSession("workspace-2");
    expect(saveEditorSession(session, storage)).toBe(true);
    expect(clearEditorSession(session.workspaceId, storage)).toBe(true);
    expect(storage.getItem(editorSessionStorageKey(session.workspaceId))).toBeNull();

    const unavailable: StorageLike = {
      getItem: () => { throw new Error("unavailable"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("unavailable"); },
    };
    expect(loadEditorSession("workspace-3", unavailable)).toEqual(createEmptyEditorSession("workspace-3"));
    expect(saveEditorSession(createEmptyEditorSession("workspace-3"), unavailable)).toBe(false);
    expect(clearEditorSession("workspace-3", unavailable)).toBe(false);
  });
});
