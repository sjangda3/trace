export type EditorDraft = {
  workspaceId: string;
  path: string;
  content: string;
  baseContent: string;
  baseMtimeMs?: number;
  updatedAt: number;
};

const DATABASE_NAME = "trace-editor";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";
const memoryDrafts = new Map<string, EditorDraft>();
let databasePromise: Promise<IDBDatabase | null> | null = null;

function draftKey(workspaceId: string, path: string) {
  return `${workspaceId}\u0000${path}`;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (databasePromise) return databasePromise;
  if (typeof indexedDB === "undefined") return Promise.resolve(null);

  databasePromise = new Promise((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  const database = await openDatabase();
  if (!database) return undefined;

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function loadEditorDraft(workspaceId: string, path: string): Promise<EditorDraft | null> {
  const key = draftKey(workspaceId, path);
  const stored = await withStore<EditorDraft>("readonly", (store) => store.get(key));
  return stored ?? memoryDrafts.get(key) ?? null;
}

export async function saveEditorDraft(draft: EditorDraft): Promise<void> {
  const key = draftKey(draft.workspaceId, draft.path);
  memoryDrafts.set(key, draft);
  await withStore<IDBValidKey>("readwrite", (store) => store.put(draft, key));
}

export async function deleteEditorDraft(workspaceId: string, path: string): Promise<void> {
  const key = draftKey(workspaceId, path);
  memoryDrafts.delete(key);
  await withStore<undefined>("readwrite", (store) => store.delete(key));
}

export async function moveEditorDraft(
  workspaceId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  const draft = await loadEditorDraft(workspaceId, oldPath);
  if (!draft) return;
  await saveEditorDraft({ ...draft, path: newPath, updatedAt: Date.now() });
  await deleteEditorDraft(workspaceId, oldPath);
}
