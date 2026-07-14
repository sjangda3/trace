import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDemoWorkspaceApi,
  detectLanguage,
  isWorkspaceError,
  loadEditorSession,
  saveEditorSession,
  workspaceApi as primaryWorkspaceApi,
  type EditorLanguageId,
  type WorkspaceApi,
  type WorkspaceDescriptor,
  type WorkspaceTextFile,
  type WorkspaceTree,
  type WorkspaceTreeNode,
} from ".";
import {
  deleteEditorDraft,
  loadEditorDraft,
  moveEditorDraft,
  saveEditorDraft,
} from "./drafts";
import { reorderByPath } from "./tabOrder";

export type OpenDocument = {
  path: string;
  name: string;
  language: EditorLanguageId;
  content: string;
  savedContent: string;
  encoding: WorkspaceTextFile["encoding"];
  mtimeMs?: number;
  size?: number;
  externalConflict: boolean;
  deleted: boolean;
};

export type EditorNotice = {
  id: number;
  tone: "info" | "error";
  message: string;
  documentPath?: string;
};

function collectFiles(tree: WorkspaceTree): string[] {
  const paths: string[] = [];
  const visit = (nodes: WorkspaceTree) => {
    for (const node of nodes) {
      if (node.kind === "directory") visit(node.children);
      else if (!node.binary) paths.push(node.path);
    }
  };
  visit(tree);
  return paths;
}

function chooseInitialFiles(tree: WorkspaceTree, limit: number): string[] {
  const files = collectFiles(tree);
  const preferredNames = [
    "product-spec.md",
    "workspace-state.ts",
    "annotation-thread.tsx",
    "project-map.tsx",
    "workspace-shell.tsx",
    "readme.md",
    "package.json",
  ];
  const selected: string[] = [];
  for (const name of preferredNames) {
    const match = files.find((path) => path.toLowerCase().endsWith(`/${name}`) || path.toLowerCase() === name);
    if (match && !selected.includes(match)) selected.push(match);
    if (selected.length === limit) return selected;
  }
  for (const path of files) {
    if (!selected.includes(path)) selected.push(path);
    if (selected.length === limit) break;
  }
  return selected;
}

async function readDocument(
  api: WorkspaceApi,
  workspace: WorkspaceDescriptor,
  path: string,
  { ignoreDraft = false }: { ignoreDraft?: boolean } = {},
): Promise<OpenDocument> {
  const file = await api.readFile(path, workspace.id);
  if (file.kind === "binary") {
    throw Object.assign(new Error(`“${file.name}” is a binary file and cannot be opened in the text editor.`), {
      code: "binary-file",
    });
  }

  const draft = ignoreDraft ? null : await loadEditorDraft(workspace.id, path);
  const draftIsDirty = Boolean(draft && draft.content !== file.content);
  const baseStillMatches = !draft || draft.baseContent === file.content;

  if (draft && !draftIsDirty) void deleteEditorDraft(workspace.id, path);

  return {
    path,
    name: file.name,
    language: file.language,
    content: draftIsDirty ? draft!.content : file.content,
    savedContent: file.content,
    encoding: file.encoding,
    mtimeMs: file.mtimeMs,
    size: file.size,
    externalConflict: draftIsDirty && !baseStillMatches,
    deleted: false,
  };
}

function messageFromError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function replacePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
  return path;
}

type PreparedWorkspace = {
  tree: WorkspaceTree;
  documents: OpenDocument[];
  activePath: string | null;
};

async function prepareWorkspace(
  api: WorkspaceApi,
  descriptor: WorkspaceDescriptor,
): Promise<PreparedWorkspace> {
  const tree = await api.getTree(descriptor.id);
  const session = loadEditorSession(descriptor.id);
  const initialFileLimit = api.source === "demo" ? 5 : 1;
  const requestedPaths = session.openTabs.length > 0
    ? session.openTabs.map((tab) => tab.path)
    : chooseInitialFiles(tree, initialFileLimit);
  const readAvailable = async (paths: string[]) => (await Promise.all(
    paths.map(async (path) => {
      try {
        return await readDocument(api, descriptor, path);
      } catch {
        return null;
      }
    }),
  )).filter((document): document is OpenDocument => document !== null);

  let documents = await readAvailable(requestedPaths);
  if (documents.length === 0 && session.openTabs.length > 0) {
    documents = await readAvailable(chooseInitialFiles(tree, initialFileLimit));
  }

  const requestedActive = session.activeFilePath;
  const activePath = requestedActive && documents.some((document) => document.path === requestedActive)
    ? requestedActive
    : documents.at(-1)?.path ?? null;
  return { tree, documents, activePath };
}

export function useWorkspaceEditor() {
  const [workspace, setWorkspace] = useState<WorkspaceDescriptor | null>(null);
  const [tree, setTree] = useState<WorkspaceTree>([]);
  const [documents, setDocuments] = useState<OpenDocument[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<EditorNotice | null>(null);
  const [windowCloseRequestToken, setWindowCloseRequestToken] = useState(0);
  const [apiSource, setApiSource] = useState<WorkspaceApi["source"]>(primaryWorkspaceApi.source);

  const apiRef = useRef<WorkspaceApi>(primaryWorkspaceApi);
  const workspaceRef = useRef<WorkspaceDescriptor | null>(workspace);
  const documentsRef = useRef<OpenDocument[]>(documents);
  const activePathRef = useRef<string | null>(activePath);
  const loadGenerationRef = useRef(0);
  const workspaceLoadRequestRef = useRef(0);
  const noticeIdRef = useRef(0);
  const savingPathsRef = useRef(new Set<string>());
  const loadingPathsRef = useRef(new Set<string>());
  const openingFilesRef = useRef(new Map<string, Promise<boolean>>());
  const requestedActivationRef = useRef<{ workspaceId: string; path: string } | null>(null);
  const treeRefreshTimerRef = useRef<number | null>(null);
  const workspaceTransitionRef = useRef(false);

  workspaceRef.current = workspace;
  documentsRef.current = documents;
  activePathRef.current = activePath;

  const showNotice = useCallback((
    message: string,
    tone: EditorNotice["tone"] = "error",
    documentPath?: string,
  ) => {
    noticeIdRef.current += 1;
    setNotice({ id: noticeIdRef.current, tone, message, documentPath });
  }, []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const loadWorkspace = useCallback(async (api: WorkspaceApi, descriptor: WorkspaceDescriptor) => {
    const request = ++workspaceLoadRequestRef.current;
    workspaceTransitionRef.current = true;
    setInitializing(true);

    try {
      const prepared = await prepareWorkspace(api, descriptor);
      if (request !== workspaceLoadRequestRef.current) return false;

      loadGenerationRef.current += 1;
      apiRef.current = api;
      workspaceRef.current = descriptor;
      documentsRef.current = prepared.documents;
      activePathRef.current = prepared.activePath;
      loadingPathsRef.current.clear();
      openingFilesRef.current.clear();
      requestedActivationRef.current = prepared.activePath
        ? { workspaceId: descriptor.id, path: prepared.activePath }
        : null;

      setNotice(null);
      setApiSource(api.source);
      setWorkspace(descriptor);
      setTree(prepared.tree);
      setDocuments(prepared.documents);
      setActivePath(prepared.activePath);
      setLoadingPaths(new Set());
      return true;
    } catch (error) {
      if (request === workspaceLoadRequestRef.current) {
        showNotice(messageFromError(error, "The workspace could not be loaded."));
      }
      return false;
    } finally {
      if (request === workspaceLoadRequestRef.current) {
        workspaceTransitionRef.current = false;
        setInitializing(false);
      }
    }
  }, [showNotice]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const current = await primaryWorkspaceApi.getCurrent();
        if (disposed) return;
        if (current) {
          await loadWorkspace(primaryWorkspaceApi, current);
          return;
        }
        const demoApi = primaryWorkspaceApi.source === "demo"
          ? primaryWorkspaceApi
          : createDemoWorkspaceApi();
        const demoWorkspace = await demoApi.getCurrent();
        if (!disposed && demoWorkspace) await loadWorkspace(demoApi, demoWorkspace);
      } catch (error) {
        if (!disposed) {
          setInitializing(false);
          showNotice(messageFromError(error, "The editor could not be initialized."));
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [loadWorkspace, showNotice]);

  const flushDrafts = useCallback(async () => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace) return;
    await Promise.all(documentsRef.current
      .filter((document) => document.content !== document.savedContent)
      .map((document) => saveEditorDraft({
        workspaceId: currentWorkspace.id,
        path: document.path,
        content: document.content,
        baseContent: document.savedContent,
        baseMtimeMs: document.mtimeMs,
        updatedAt: Date.now(),
      })));
  }, []);

  const openFolder = useCallback(async () => {
    if (workspaceTransitionRef.current) {
      showNotice("Wait for the current workspace switch to finish.", "info");
      return;
    }
    const hasDirtyDocuments = documentsRef.current.some(
      (document) => document.content !== document.savedContent,
    );
    if (hasDirtyDocuments) {
      await flushDrafts();
      const shouldContinue = window.confirm(
        "Switch folders? Your unsaved changes will stay safely stored as drafts in this workspace.",
      );
      if (!shouldContinue) return;
    }

    const targetApi = primaryWorkspaceApi.source === "electron" ? primaryWorkspaceApi : apiRef.current;
    workspaceTransitionRef.current = true;
    setInitializing(true);
    try {
      const descriptor = await targetApi.openFolder();
      if (descriptor) {
        await loadWorkspace(targetApi, descriptor);
      } else {
        workspaceTransitionRef.current = false;
        setInitializing(false);
      }
    } catch (error) {
      workspaceTransitionRef.current = false;
      setInitializing(false);
      if (isWorkspaceError(error) && error.code === "cancelled") return;
      showNotice(messageFromError(error, "The folder could not be opened."));
    }
  }, [flushDrafts, loadWorkspace, showNotice]);

  const refreshTree = useCallback(async () => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace || workspaceTransitionRef.current) return;
    const api = apiRef.current;
    const generation = loadGenerationRef.current;
    try {
      const nextTree = await api.getTree(currentWorkspace.id);
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id ||
        workspaceTransitionRef.current
      ) return;
      setTree(nextTree);
    } catch (error) {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return;
      showNotice(messageFromError(error, "The file tree could not be refreshed."));
    }
  }, [showNotice]);

  const scheduleTreeRefresh = useCallback(() => {
    if (treeRefreshTimerRef.current !== null) window.clearTimeout(treeRefreshTimerRef.current);
    treeRefreshTimerRef.current = window.setTimeout(() => {
      treeRefreshTimerRef.current = null;
      void refreshTree();
    }, 120);
  }, [refreshTree]);

  const openFile = useCallback(async (path: string): Promise<boolean> => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace || workspaceTransitionRef.current) return false;
    requestedActivationRef.current = { workspaceId: currentWorkspace.id, path };
    if (documentsRef.current.some((document) => document.path === path)) {
      setActivePath(path);
      activePathRef.current = path;
      return true;
    }
    const openingKey = `${currentWorkspace.id}\0${path}`;
    const existing = openingFilesRef.current.get(openingKey);
    if (existing) return existing;
    const api = apiRef.current;
    const generation = loadGenerationRef.current;

    loadingPathsRef.current.add(path);
    setLoadingPaths((current) => new Set(current).add(path));
    const opening = (async () => {
      try {
        const document = await readDocument(api, currentWorkspace, path);
        if (
          generation !== loadGenerationRef.current ||
          apiRef.current !== api ||
          workspaceRef.current?.id !== currentWorkspace.id ||
          workspaceTransitionRef.current
        ) return false;
        setDocuments((current) => {
          if (current.some((item) => item.path === path)) return current;
          const next = [...current, document];
          documentsRef.current = next;
          return next;
        });
        const requested = requestedActivationRef.current;
        const shouldActivate = requested?.workspaceId === currentWorkspace.id && requested.path === path;
        if (shouldActivate) {
          setActivePath(path);
          activePathRef.current = path;
        }
        return shouldActivate;
      } catch (error) {
        if (
          generation === loadGenerationRef.current &&
          apiRef.current === api &&
          workspaceRef.current?.id === currentWorkspace.id
        ) showNotice(messageFromError(error, `“${path}” could not be opened.`));
        return false;
      } finally {
        if (
          generation === loadGenerationRef.current &&
          apiRef.current === api &&
          workspaceRef.current?.id === currentWorkspace.id
        ) {
          setLoadingPaths((current) => {
            const next = new Set(current);
            next.delete(path);
            return next;
          });
          loadingPathsRef.current.delete(path);
        }
      }
    })();
    openingFilesRef.current.set(openingKey, opening);
    void opening.finally(() => {
      if (openingFilesRef.current.get(openingKey) === opening) {
        openingFilesRef.current.delete(openingKey);
      }
    });
    return opening;
  }, [showNotice]);

  const updateDocument = useCallback((path: string, content: string) => {
    setDocuments((current) => {
      const next = current.map((document) => document.path === path ? { ...document, content } : document);
      documentsRef.current = next;
      return next;
    });
  }, []);

  const saveDocument = useCallback(async (path = activePathRef.current, force = false): Promise<boolean> => {
    if (!path) return false;
    const document = documentsRef.current.find((item) => item.path === path);
    const currentWorkspace = workspaceRef.current;
    if (!document || !currentWorkspace) return false;
    if (workspaceTransitionRef.current) {
      showNotice("Wait for the new workspace to finish opening before saving.");
      return false;
    }
    if (savingPathsRef.current.has(path)) return false;

    const api = apiRef.current;
    const generation = loadGenerationRef.current;
    savingPathsRef.current.add(path);
    try {
      const result = await api.saveFile(
        path,
        document.content,
        force ? undefined : document.mtimeMs,
        currentWorkspace.id,
      );
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      setDocuments((current) => {
        const next = current.map((item) => item.path === path ? {
          ...item,
          savedContent: document.content,
          mtimeMs: result.mtimeMs,
          size: result.size,
          externalConflict: false,
          deleted: false,
        } : item);
        documentsRef.current = next;
        return next;
      });
      const latestDocument = documentsRef.current.find((item) => item.path === path);
      if (!latestDocument || latestDocument.content === document.content) {
        await deleteEditorDraft(currentWorkspace.id, path);
      } else {
        await saveEditorDraft({
          workspaceId: currentWorkspace.id,
          path,
          content: latestDocument.content,
          baseContent: document.content,
          baseMtimeMs: result.mtimeMs,
          updatedAt: Date.now(),
        });
      }
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      showNotice(`Saved ${document.name}`, "info");
      return Boolean(latestDocument && latestDocument.content === document.content);
    } catch (error) {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      if (isWorkspaceError(error) && error.code === "conflict") {
        setDocuments((current) => {
          const next = current.map((item) => item.path === path
            ? { ...item, externalConflict: true }
            : item);
          documentsRef.current = next;
          return next;
        });
      }
      showNotice(messageFromError(error, `“${document.name}” could not be saved.`), "error", path);
      return false;
    } finally {
      savingPathsRef.current.delete(path);
    }
  }, [showNotice]);

  const reloadDocument = useCallback(async (path = activePathRef.current): Promise<boolean> => {
    const currentWorkspace = workspaceRef.current;
    if (!path || !currentWorkspace) return false;
    const api = apiRef.current;
    const generation = loadGenerationRef.current;
    try {
      const reloaded = await readDocument(api, currentWorkspace, path, { ignoreDraft: true });
      await deleteEditorDraft(currentWorkspace.id, path);
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      setDocuments((current) => {
        const next = current.map((item) => item.path === path ? reloaded : item);
        documentsRef.current = next;
        return next;
      });
      showNotice(`Reloaded ${reloaded.name}`, "info", path);
      return true;
    } catch (error) {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      showNotice(messageFromError(error, `“${path}” could not be reloaded.`));
      return false;
    }
  }, [showNotice]);

  const closeDocument = useCallback((path: string, discardDraft = false) => {
    const current = documentsRef.current;
    const index = current.findIndex((document) => document.path === path);
    if (index === -1) return;
    const next = current.filter((document) => document.path !== path);
    documentsRef.current = next;
    setDocuments(next);

    if (activePathRef.current === path) {
      const nextActive = next[Math.min(index, next.length - 1)]?.path ?? null;
      requestedActivationRef.current = nextActive && workspaceRef.current
        ? { workspaceId: workspaceRef.current.id, path: nextActive }
        : null;
      activePathRef.current = nextActive;
      setActivePath(nextActive);
    }
    if (discardDraft && workspaceRef.current) {
      void deleteEditorDraft(workspaceRef.current.id, path);
    }
  }, []);

  const selectDocument = useCallback((path: string) => {
    if (!documentsRef.current.some((document) => document.path === path)) return;
    const currentWorkspace = workspaceRef.current;
    requestedActivationRef.current = currentWorkspace
      ? { workspaceId: currentWorkspace.id, path }
      : null;
    activePathRef.current = path;
    setActivePath(path);
  }, []);

  const reorderDocuments = useCallback((draggedPath: string, targetPath: string): boolean => {
    const current = documentsRef.current;
    const next = reorderByPath(current, draggedPath, targetPath);
    if (next === current) return false;
    documentsRef.current = next;
    setDocuments(next);
    return true;
  }, []);

  const createFile = useCallback(async (parentPath: string, name: string) => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace || workspaceTransitionRef.current) return null;
    const api = apiRef.current;
    const generation = loadGenerationRef.current;
    try {
      const node = await api.createFile(parentPath, name, currentWorkspace.id);
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      await refreshTree();
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      await openFile(node.path);
      return node;
    } catch (error) {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      showNotice(messageFromError(error, `“${name}” could not be created.`));
      return null;
    }
  }, [openFile, refreshTree, showNotice]);

  const createFolder = useCallback(async (parentPath: string, name: string) => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace || workspaceTransitionRef.current) return null;
    const api = apiRef.current;
    const generation = loadGenerationRef.current;
    try {
      const node = await api.createFolder(parentPath, name, currentWorkspace.id);
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      await refreshTree();
      return node;
    } catch (error) {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      showNotice(messageFromError(error, `“${name}” could not be created.`));
      return null;
    }
  }, [refreshTree, showNotice]);

  const renameEntry = useCallback(async (path: string, newName: string) => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace || workspaceTransitionRef.current) return null;
    const api = apiRef.current;
    const generation = loadGenerationRef.current;
    try {
      const node = await api.rename(path, newName, currentWorkspace.id);
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      const moves = documentsRef.current
        .filter((document) => document.path === path || document.path.startsWith(`${path}/`))
        .map((document) => [document.path, replacePathPrefix(document.path, path, node.path)] as const);
      setDocuments((current) => {
        const next = current.map((document) => {
          const nextPath = replacePathPrefix(document.path, path, node.path);
          return nextPath === document.path
            ? document
            : {
                ...document,
                path: nextPath,
                name: nextPath.split("/").pop() ?? nextPath,
                language: detectLanguage(nextPath, document.content),
              };
        });
        documentsRef.current = next;
        return next;
      });
      if (activePathRef.current) {
        const nextActive = replacePathPrefix(activePathRef.current, path, node.path);
        activePathRef.current = nextActive;
        setActivePath(nextActive);
      }
      if (currentWorkspace) {
        await Promise.all(moves.map(([oldPath, nextPath]) => moveEditorDraft(currentWorkspace.id, oldPath, nextPath)));
      }
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      await refreshTree();
      return node;
    } catch (error) {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return null;
      showNotice(messageFromError(error, `“${path}” could not be renamed.`));
      return null;
    }
  }, [refreshTree, showNotice]);

  const deleteEntry = useCallback(async (path: string) => {
    const currentWorkspace = workspaceRef.current;
    if (!currentWorkspace || workspaceTransitionRef.current) return false;
    const api = apiRef.current;
    const generation = loadGenerationRef.current;
    const affectedDocuments = documentsRef.current.filter(
      (document) => document.path === path || document.path.startsWith(`${path}/`),
    );
    if (affectedDocuments.some((document) => document.content !== document.savedContent)) {
      showNotice("Save or close the unsaved files inside this entry before deleting it.");
      return false;
    }
    try {
      await api.delete(path, currentWorkspace.id);
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      const removed = affectedDocuments;
      for (const document of removed) closeDocument(document.path, true);
      if (currentWorkspace) {
        await Promise.all(removed.map((document) => deleteEditorDraft(currentWorkspace.id, document.path)));
      }
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      await refreshTree();
      return true;
    } catch (error) {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return false;
      showNotice(messageFromError(error, `“${path}” could not be deleted.`));
      return false;
    }
  }, [closeDocument, refreshTree, showNotice]);

  useEffect(() => {
    const currentWorkspace = workspace;
    if (!currentWorkspace || initializing) return;
    saveEditorSession({
      version: 1,
      workspaceId: currentWorkspace.id,
      openTabs: documents.map((document) => ({ path: document.path })),
      activeFilePath: activePath,
    });
  }, [activePath, documents, initializing, workspace]);

  useEffect(() => {
    const currentWorkspace = workspace;
    if (!currentWorkspace) return;
    const timer = window.setTimeout(() => {
      for (const document of documents) {
        if (document.content === document.savedContent) {
          void deleteEditorDraft(currentWorkspace.id, document.path);
          continue;
        }
        void saveEditorDraft({
          workspaceId: currentWorkspace.id,
          path: document.path,
          content: document.content,
          baseContent: document.savedContent,
          baseMtimeMs: document.mtimeMs,
          updatedAt: Date.now(),
        });
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [documents, workspace]);

  useEffect(() => {
    const api = apiRef.current;
    const currentWorkspace = workspace;
    if (!currentWorkspace) return;
    const generation = loadGenerationRef.current;

    const disposeChanges = api.onDidChange((event) => {
      if (
        generation !== loadGenerationRef.current ||
        apiRef.current !== api ||
        workspaceRef.current?.id !== currentWorkspace.id
      ) return;
      if (event.workspaceId && event.workspaceId !== currentWorkspace.id) return;
      scheduleTreeRefresh();
      const path = event.path;
      if (!path) return;

      if (event.kind === "deleted") {
        const affectedDocuments = documentsRef.current.filter(
          (item) => item.path === path || item.path.startsWith(`${path}/`),
        );
        if (affectedDocuments.length === 0) return;
        const dirtyDocuments = affectedDocuments.filter(
          (document) => document.content !== document.savedContent,
        );
        if (dirtyDocuments.length > 0) {
          const deletedPaths = new Set(dirtyDocuments.map((document) => document.path));
          setDocuments((current) => {
            const next = current.map((item) => deletedPaths.has(item.path)
              ? { ...item, deleted: true, externalConflict: true }
              : item);
            documentsRef.current = next;
            return next;
          });
          const document = dirtyDocuments[0];
          showNotice(
            dirtyDocuments.length === 1
              ? `${document.name} was deleted on disk. Your unsaved version is still open.`
              : `${dirtyDocuments.length} unsaved files were deleted on disk. Your versions are still open.`,
            "error",
            document.path,
          );
        }
        for (const document of affectedDocuments) {
          if (document.content === document.savedContent) closeDocument(document.path);
        }
        return;
      }

      if (savingPathsRef.current.has(path)) return;
      const document = documentsRef.current.find((item) => item.path === path);
      if (!document) return;

      void (async () => {
        try {
          const latest = await api.readFile(path, currentWorkspace.id);
          if (
            generation !== loadGenerationRef.current ||
            apiRef.current !== api ||
            workspaceRef.current?.id !== currentWorkspace.id
          ) return;
          if (latest.kind !== "text") return;
          const currentDocument = documentsRef.current.find((item) => item.path === path);
          if (!currentDocument) return;
          if (currentDocument.content !== currentDocument.savedContent) {
            if (latest.content !== currentDocument.savedContent) {
              setDocuments((current) => {
                const next = current.map((item) => item.path === path
                  ? { ...item, externalConflict: true }
                  : item);
                documentsRef.current = next;
                return next;
              });
              showNotice(
                `${document.name} changed on disk while you have unsaved edits.`,
                "error",
                path,
              );
            }
            return;
          }
          setDocuments((current) => {
            const next = current.map((item) => item.path === path ? {
              ...item,
              content: latest.content,
              savedContent: latest.content,
              mtimeMs: latest.mtimeMs,
              size: latest.size,
              deleted: false,
              externalConflict: false,
            } : item);
            documentsRef.current = next;
            return next;
          });
        } catch {
          // A rename event can represent a deletion; the refreshed tree remains authoritative.
        }
      })();
    });

    const disposeCommands = api.onCommand((event) => {
      if (event.command === "open-folder") void openFolder();
      if (event.command === "close-window") setWindowCloseRequestToken((value) => value + 1);
    });

    return () => {
      disposeChanges();
      disposeCommands();
      if (treeRefreshTimerRef.current !== null) window.clearTimeout(treeRefreshTimerRef.current);
    };
  }, [closeDocument, openFolder, scheduleTreeRefresh, showNotice, workspace]);

  const activeDocument = documents.find((document) => document.path === activePath) ?? null;

  return {
    workspace,
    tree,
    documents,
    activePath,
    activeDocument,
    initializing,
    loadingPaths,
    notice,
    apiSource,
    windowCloseRequestToken,
    openFolder,
    openFile,
    selectDocument,
    reorderDocuments,
    updateDocument,
    saveDocument,
    reloadDocument,
    closeDocument,
    createFile,
    createFolder,
    renameEntry,
    deleteEntry,
    refreshTree,
    flushDrafts,
    dismissNotice,
  };
}
