import type {
  EditorSessionState,
  EditorViewState,
  PersistedEditorTab,
  WorkspaceId,
} from "./types";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = "trace:editor-session:v1:";

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function parseViewState(value: unknown): EditorViewState | undefined {
  if (!isRecord(value)) return undefined;
  const scrollTop = finiteNonNegative(value.scrollTop);
  const scrollLeft = finiteNonNegative(value.scrollLeft);
  let validSelection: EditorViewState["selection"];
  if (isRecord(value.selection)) {
    const startLineNumber = positiveInteger(value.selection.startLineNumber);
    const startColumn = positiveInteger(value.selection.startColumn);
    const endLineNumber = positiveInteger(value.selection.endLineNumber);
    const endColumn = positiveInteger(value.selection.endColumn);
    if (startLineNumber && startColumn && endLineNumber && endColumn) {
      validSelection = { startLineNumber, startColumn, endLineNumber, endColumn };
    }
  }
  if (scrollTop === undefined && scrollLeft === undefined && !validSelection) return undefined;
  return {
    ...(scrollTop !== undefined ? { scrollTop } : {}),
    ...(scrollLeft !== undefined ? { scrollLeft } : {}),
    ...(validSelection ? { selection: validSelection } : {}),
  };
}

function parseTabs(value: unknown): PersistedEditorTab[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const tabs: PersistedEditorTab[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path || seen.has(item.path)) continue;
    seen.add(item.path);
    const viewState = parseViewState(item.viewState);
    tabs.push({
      path: item.path,
      ...(typeof item.isPinned === "boolean" ? { isPinned: item.isPinned } : {}),
      ...(viewState ? { viewState } : {}),
    });
  }
  return tabs;
}

export function editorSessionStorageKey(workspaceId: WorkspaceId): string {
  return `${KEY_PREFIX}${encodeURIComponent(workspaceId)}`;
}

export function createEmptyEditorSession(workspaceId: WorkspaceId): EditorSessionState {
  return { version: 1, workspaceId, openTabs: [], activeFilePath: null };
}

/** Reads a session defensively. Invalid, old, or unavailable storage becomes an empty session. */
export function loadEditorSession(
  workspaceId: WorkspaceId,
  storage: StorageLike | undefined = defaultStorage(),
): EditorSessionState {
  if (!storage) return createEmptyEditorSession(workspaceId);
  try {
    const serialized = storage.getItem(editorSessionStorageKey(workspaceId));
    if (!serialized) return createEmptyEditorSession(workspaceId);
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== 1 || parsed.workspaceId !== workspaceId) {
      return createEmptyEditorSession(workspaceId);
    }
    const openTabs = parseTabs(parsed.openTabs);
    const requestedActive = typeof parsed.activeFilePath === "string" ? parsed.activeFilePath : null;
    const activeFilePath = requestedActive && openTabs.some((tab) => tab.path === requestedActive)
      ? requestedActive
      : openTabs[0]?.path ?? null;
    return { version: 1, workspaceId, openTabs, activeFilePath };
  } catch {
    return createEmptyEditorSession(workspaceId);
  }
}

/** Returns false when persistence is unavailable (private mode, quota, or SSR). */
export function saveEditorSession(
  session: EditorSessionState,
  storage: StorageLike | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    const openTabs = parseTabs(session.openTabs);
    const activeFilePath = session.activeFilePath && openTabs.some((tab) => tab.path === session.activeFilePath)
      ? session.activeFilePath
      : openTabs[0]?.path ?? null;
    storage.setItem(
      editorSessionStorageKey(session.workspaceId),
      JSON.stringify({ version: 1, workspaceId: session.workspaceId, openTabs, activeFilePath }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearEditorSession(
  workspaceId: WorkspaceId,
  storage: StorageLike | undefined = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(editorSessionStorageKey(workspaceId));
    return true;
  } catch {
    return false;
  }
}
