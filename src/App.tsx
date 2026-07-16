import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, MotionConfig, motion } from "motion/react";
import {
  Bell,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleUserRound,
  Database,
  FileCode2,
  FileJson2,
  FilePlus2,
  FileText,
  Filter,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
  ListTree,
  LoaderCircle,
  Maximize2,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  MonacoEditor,
  type CursorPosition,
  type MonacoEditorHandle,
} from "./editor/MonacoEditor";
import {
  breadcrumbSegments,
  flattenWorkspaceTree,
  type WorkspaceTreeRow,
} from "./editor/tree";
import type { WorkspaceTree, WorkspaceTreeNode } from "./editor";
import { useWorkspaceEditor, type OpenDocument } from "./editor/useWorkspaceEditor";
import { TerminalDrawer } from "./terminal/TerminalDrawer";
import { useTerminalSessions } from "./terminal/useTerminalSessions";
import { LanguageSupportSidebar } from "./tooling";
import { SearchSidebar, type WorkspaceSearchSelection } from "./search";
import {
  BranchesView,
  GitHistoryPanel,
  GitPatchPanel,
  SourceControlSidebar,
} from "./git/components";
import { useGitWorkspace, type GitFileDiff, type GitFileStatus } from "./git";
import {
  IssuePanel,
  PullRequestPanel,
  RepositorySidebar,
  useGitHubWorkspace,
  type GitHubIssueSummary,
  type GitHubPullRequestFile,
  type GitHubPullRequestSummary,
  type GitHubRepositoryView,
  type GitHubReviewAnchor,
  type GitHubReviewThread,
} from "./github";
import {
  AnnotationPanel,
  CollaborationSidebar,
  DemoCollaborationApi,
  collaborationApi,
  useCollaborationWorkspace,
  type AnnotationAnchor,
  type CodeAnnotation,
  type CollaborationApi,
} from "./collaboration";
import { Onboarding } from "./account/Onboarding";
import { traceAccountApi } from "./account/api";
import { launchViewForAccount, type TraceLaunchView } from "./account/launch-state";
import "./git/git.css";

type RailItem = {
  id: "files" | "search" | "source" | "branches" | "workspace" | "extensions";
  label: string;
  icon: LucideIcon;
};

type FileVisualKind = "folder" | "tsx" | "ts" | "json" | "md" | "code";

type ContextMenuState = {
  x: number;
  y: number;
  node: WorkspaceTreeNode | null;
};

type PendingReviewFocus = {
  workspaceId: string;
  path: string;
  startLine: number;
  endLine: number;
};

type PendingAnnotationFocus = AnnotationAnchor & {
  workspaceId: string;
};

type PendingSearchFocus = WorkspaceSearchSelection & {
  workspaceId: string;
  requestId: number;
};

type NavigationHistory = {
  workspaceId: string | null;
  entries: string[];
  index: number;
};

const railItems: RailItem[] = [
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "search", label: "Search", icon: Search },
  { id: "source", label: "Source control", icon: GitBranch },
  { id: "branches", label: "Branches and pull requests", icon: GitFork },
  { id: "workspace", label: "Workspace", icon: Box },
  { id: "extensions", label: "Extensions", icon: Puzzle },
];

async function hashTextContent(content: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function visualKind(name: string, isDirectory = false): FileVisualKind {
  if (isDirectory) return "folder";
  const extension = name.toLowerCase().split(".").pop();
  if (extension === "tsx" || extension === "jsx") return "tsx";
  if (["ts", "js", "mjs", "cjs"].includes(extension ?? "")) return "ts";
  if (["json", "jsonc"].includes(extension ?? "")) return "json";
  if (["md", "mdx", "markdown"].includes(extension ?? "")) return "md";
  return "code";
}

function IconButton({
  icon: Icon,
  label,
  active,
  onClick,
  disabled = false,
  className = "",
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${active ? "is-active" : ""} ${className}`}
      aria-pressed={active === undefined ? undefined : active}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

function FileGlyph({ kind }: { kind: FileVisualKind }) {
  if (kind === "folder") return <Folder aria-hidden="true" />;
  if (kind === "json") return <FileJson2 aria-hidden="true" />;
  if (kind === "md") return <FileText aria-hidden="true" />;
  return <FileCode2 aria-hidden="true" />;
}

function TreeRow({
  row,
  active,
  expanded,
  loading,
  onSelect,
  onContextMenu,
}: {
  row: WorkspaceTreeRow;
  active: boolean;
  expanded: boolean;
  loading: boolean;
  onSelect: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const directory = row.node.kind === "directory";
  const kind = visualKind(row.node.name, directory);
  return (
    <button
      type="button"
      className={`tree-row ${row.depth > 0 ? "tree-row--nested" : ""} ${active ? "is-active" : ""} ${row.node.hidden ? "is-muted" : ""}`}
      style={{ "--tree-depth": row.depth } as React.CSSProperties}
      aria-expanded={directory ? expanded : undefined}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      title={row.path}
    >
      {row.depth > 0 ? (
        <span className="tree-row-guides" aria-hidden="true">
          {Array.from({ length: row.depth }, (_, depth) => (
            <span
              className={`tree-row-guide ${depth === row.depth - 1 ? "is-branch" : ""}`}
              key={depth}
              style={{ "--tree-guide-depth": depth } as React.CSSProperties}
            />
          ))}
        </span>
      ) : null}
      <span className="tree-row-content">
        <span className="tree-chevron">
          <AnimatePresence initial={false} mode="wait">
            {loading ? (
              <motion.span
                className="tree-chevron-state"
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1, ease: "easeOut" }}
              >
                <LoaderCircle className="tree-loader" />
              </motion.span>
            ) : directory ? (
              <motion.span
                className={`tree-chevron-state tree-chevron-icon ${expanded ? "is-expanded" : ""}`}
                key="chevron"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1, ease: "easeOut" }}
              >
                <ChevronRight />
              </motion.span>
            ) : null}
          </AnimatePresence>
        </span>
        <span className={`file-glyph file-glyph--${kind}`}>
          <FileGlyph kind={kind} />
        </span>
        <span className="tree-label">{row.node.name}</span>
      </span>
    </button>
  );
}

function TreeMenu({
  menu,
  onClose,
  onOpenFolder,
  onRefresh,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onRename: (node: WorkspaceTreeNode) => void;
  onDelete: (node: WorkspaceTreeNode) => void;
}) {
  const directory = menu.node?.kind === "directory";
  const parentPath = directory
    ? menu.node!.path
    : menu.node?.path.split("/").slice(0, -1).join("/") ?? "";

  return (
    <motion.div
      className="tree-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      initial={{ opacity: 0, scale: 0.98, y: -3 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: -3 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" role="menuitem" onClick={() => { onNewFile(parentPath); onClose(); }}>
        <FilePlus2 />New File
      </button>
      <button type="button" role="menuitem" onClick={() => { onNewFolder(parentPath); onClose(); }}>
        <FolderPlus />New Folder
      </button>
      {menu.node ? <span className="menu-separator" /> : null}
      {menu.node ? (
        <button type="button" role="menuitem" onClick={() => { onRename(menu.node!); onClose(); }}>
          Rename
        </button>
      ) : null}
      {menu.node ? (
        <button className="is-danger" type="button" role="menuitem" onClick={() => { onDelete(menu.node!); onClose(); }}>
          <Trash2 />Delete
        </button>
      ) : null}
      {!menu.node ? <span className="menu-separator" /> : null}
      {!menu.node ? (
        <button type="button" role="menuitem" onClick={() => { onRefresh(); onClose(); }}>
          <RefreshCw />Refresh
        </button>
      ) : null}
      {!menu.node ? (
        <button type="button" role="menuitem" onClick={() => { onOpenFolder(); onClose(); }}>
          <FolderOpen />Open Folder…
        </button>
      ) : null}
    </motion.div>
  );
}

function Sidebar({
  workspaceName,
  tree,
  activePath,
  loadingPaths,
  onOpenFile,
  onOpenFolder,
  onRefresh,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: {
  workspaceName: string;
  tree: WorkspaceTree;
  activePath: string | null;
  loadingPaths: ReadonlySet<string>;
  onOpenFile: (path: string) => void;
  onOpenFolder: () => void;
  onRefresh: () => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onRename: (node: WorkspaceTreeNode) => void;
  onDelete: (node: WorkspaceTreeNode) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      if (activePath) {
        const segments = activePath.split("/");
        for (let index = 1; index < segments.length; index += 1) {
          next.add(segments.slice(0, index).join("/"));
        }
      }
      const expandCollaboration = (nodes: WorkspaceTree) => {
        for (const node of nodes) {
          if (node.kind !== "directory") continue;
          if (node.path.endsWith("/components/collaboration")) next.add(node.path);
          expandCollaboration(node.children);
        }
      };
      expandCollaboration(tree);
      return next;
    });
  }, [activePath, tree]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const rows = useMemo(
    () => flattenWorkspaceTree(tree, expanded, query),
    [expanded, query, tree],
  );

  const toggleDirectory = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <aside className="sidebar panel-surface">
      <label className="search-field">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          aria-label="Search workspace files"
        />
        <button
          className="sidebar-menu-trigger"
          type="button"
          aria-label="File tree actions"
          title="File tree actions"
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setMenu({ x: Math.min(bounds.right - 170, window.innerWidth - 180), y: bounds.bottom + 2, node: null });
          }}
        >
          <Filter aria-hidden="true" />
        </button>
      </label>

      <button
        className="workspace-root"
        type="button"
        title="Open another folder"
        onClick={onOpenFolder}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, node: null });
        }}
      >
        <span className="workspace-folder"><Folder aria-hidden="true" /></span>
        <span>{workspaceName}</span>
      </button>

      <div className="tree-scroll">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((row) => (
            <motion.div
              className="tree-row-motion"
              key={row.path}
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
            >
              <TreeRow
                row={row}
                active={row.path === activePath}
                expanded={expanded.has(row.path)}
                loading={loadingPaths.has(row.path)}
                onSelect={() => row.node.kind === "directory" ? toggleDirectory(row.path) : onOpenFile(row.path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, node: row.node });
                }}
              />
            </motion.div>
          ))}
          {rows.length === 0 ? (
            <motion.div
              className="tree-empty"
              key="empty-tree"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
            >
              {query ? "No matching files" : "This folder is empty"}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="sidebar-scrollbar" aria-hidden="true"><span /></div>
      <AnimatePresence>
        {menu ? (
          <TreeMenu
            menu={menu}
            onClose={() => setMenu(null)}
            onOpenFolder={onOpenFolder}
            onRefresh={onRefresh}
            onNewFile={onNewFile}
            onNewFolder={onNewFolder}
            onRename={onRename}
            onDelete={onDelete}
          />
        ) : null}
      </AnimatePresence>
    </aside>
  );
}

function Tabs({
  documents,
  activePath,
  onSelect,
  onClose,
  onReorderDocuments,
  onNewFile,
  onToggleMaximize,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: {
  documents: OpenDocument[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorderDocuments: (draggedPath: string, targetPath: string) => void;
  onNewFile: () => void;
  onToggleMaximize: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}) {
  const draggedPathRef = useRef<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const selectAdjacentTab = (event: React.KeyboardEvent, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, index - 1);
    else if (event.key === "ArrowRight") nextIndex = Math.min(documents.length - 1, index + 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = documents.length - 1;
    else return;
    event.preventDefault();
    if (event.altKey && nextIndex !== index) {
      const currentDocument = documents[index];
      const targetDocument = documents[nextIndex];
      if (currentDocument && targetDocument) {
        onReorderDocuments(currentDocument.path, targetDocument.path);
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLButtonElement>(`[data-tab-path="${CSS.escape(currentDocument.path)}"]`)?.focus();
        });
      }
      return;
    }
    const nextDocument = documents[nextIndex];
    if (!nextDocument) return;
    onSelect(nextDocument.path);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-tab-path="${CSS.escape(nextDocument.path)}"]`)?.focus();
    });
  };

  return (
    <div className="tabbar">
      <div className="tab-history">
        <IconButton icon={ChevronLeft} label="Back" disabled={!canGoBack} onClick={onGoBack} />
        <IconButton icon={ChevronRight} label="Forward" disabled={!canGoForward} onClick={onGoForward} />
      </div>
      <LayoutGroup id="editor-tabs">
        <div
          className="tabs-scroll"
          role="tablist"
          aria-label="Open files"
        >
          <AnimatePresence initial={false} mode="popLayout">
            {documents.map((document, index) => {
              const dirty = document.content !== document.savedContent;
              const active = document.path === activePath;
              const kind = visualKind(document.name);
              return (
                <motion.div
                  className={`file-tab ${active ? "is-active" : ""} ${dirty ? "is-dirty" : ""} ${dropTargetPath === document.path && draggedPathRef.current !== document.path ? "is-drop-target" : ""}`}
                  key={document.path}
                  title={`${document.path} · Drag to reorder (Option + ←/→ also works)`}
                  layout="position"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.14, ease: "easeOut" }}
                  draggable
                  onDragStartCapture={(event) => {
                    draggedPathRef.current = document.path;
                    setDropTargetPath(null);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", document.path);
                  }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (draggedPathRef.current && draggedPathRef.current !== document.path) {
                      setDropTargetPath(document.path);
                    }
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const draggedPath = draggedPathRef.current || event.dataTransfer.getData("text/plain");
                    if (draggedPath && draggedPath !== document.path) {
                      onReorderDocuments(draggedPath, document.path);
                    }
                    draggedPathRef.current = null;
                    setDropTargetPath(null);
                  }}
                  onDragEndCapture={() => {
                    draggedPathRef.current = null;
                    setDropTargetPath(null);
                  }}
                >
                  <button
                    className="tab-select"
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    tabIndex={active ? 0 : -1}
                    data-tab-path={document.path}
                    onClick={() => onSelect(document.path)}
                    onKeyDown={(event) => selectAdjacentTab(event, index)}
                  >
                    <span className={`tab-glyph tab-glyph--${kind}`}><FileGlyph kind={kind} /></span>
                    <span className="tab-label">{document.name}</span>
                    {active ? (
                      <motion.span
                        className="tab-active-indicator"
                        layoutId="active-tab-indicator"
                        transition={{ duration: 0.14, ease: "easeOut" }}
                      />
                    ) : null}
                  </button>
                  <button
                    className="tab-close"
                    type="button"
                    aria-label={`Close ${document.name}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      onClose(document.path);
                    }}
                  >
                    {dirty ? <span className="dirty-dot" /> : <X aria-hidden="true" />}
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </LayoutGroup>
      <div className="tab-actions">
        <IconButton icon={Plus} label="New file" onClick={onNewFile} />
        <IconButton icon={Maximize2} label="Maximize editor" onClick={onToggleMaximize} />
      </div>
    </div>
  );
}

function BreadcrumbBar({
  document,
  editorRef,
}: {
  document: OpenDocument | null;
  editorRef: React.RefObject<MonacoEditorHandle | null>;
}) {
  const segments = document ? breadcrumbSegments(document.path) : [];
  return (
    <div className="breadcrumbbar">
      <div className="breadcrumbs">
        <FileCode2 className="breadcrumb-file" aria-hidden="true" />
        {segments.map((segment, index) => (
          <span className="breadcrumb-segment" key={`${segment}-${index}`}>
            {index > 0 ? <span className="crumb-separator">/</span> : null}
            {index === segments.length - 1 ? <strong>{segment}</strong> : <span>{segment}</span>}
          </span>
        ))}
      </div>
      <div className="editor-actions">
        <IconButton icon={Sparkles} label="Command palette" onClick={() => editorRef.current?.openCommandPalette()} />
        <IconButton icon={Search} label="Find" onClick={() => editorRef.current?.find()} />
        <span className="toolbar-divider" />
        <button className="text-control" type="button" onClick={() => editorRef.current?.resetZoom()}>1:1</button>
        <button className="text-control" type="button" onClick={() => editorRef.current?.toggleWordWrap()}>Text</button>
        <IconButton icon={Zap} label="Quick actions" onClick={() => editorRef.current?.openCommandPalette()} />
        <IconButton icon={SlidersHorizontal} label="More editor commands" onClick={() => editorRef.current?.openCommandPalette()} />
      </div>
    </div>
  );
}

function QuickOpen({
  tree,
  onOpen,
  onClose,
}: {
  tree: WorkspaceTree;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const allDirectories = useMemo(() => {
    const paths = new Set<string>();
    const visit = (nodes: WorkspaceTree) => {
      for (const node of nodes) {
        if (node.kind !== "directory") continue;
        paths.add(node.path);
        visit(node.children);
      }
    };
    visit(tree);
    return paths;
  }, [tree]);
  const rows = useMemo(
    () => flattenWorkspaceTree(tree, allDirectories, query).filter((row) => row.node.kind !== "directory").slice(0, 14),
    [allDirectories, query, tree],
  );

  useEffect(() => inputRef.current?.focus(), []);

  return (
    <motion.div
      className="quick-open-backdrop"
      onMouseDown={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
    >
      <motion.div
        className="quick-open"
        role="dialog"
        aria-modal="true"
        aria-label="Quick open"
        initial={{ opacity: 0, y: -8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.985 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label><Search /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Go to file…" onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Enter" && rows[0]) { onOpen(rows[0].path); onClose(); }
        }} /></label>
        <div className="quick-open-results">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row, index) => {
              const kind = visualKind(row.node.name);
              return (
                <motion.button
                  className={index === 0 ? "is-active" : ""}
                  type="button"
                  key={row.path}
                  layout="position"
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -2 }}
                  transition={{ duration: 0.1, ease: "easeOut" }}
                  onClick={() => { onOpen(row.path); onClose(); }}
                >
                  <span className={`tab-glyph tab-glyph--${kind}`}><FileGlyph kind={kind} /></span>
                  <span>{row.node.name}</span><small>{row.path}</small>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}

function DirtyCloseDialog({
  document,
  onCancel,
  onDiscard,
  onSave,
}: {
  document: OpenDocument;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  return (
    <motion.div
      className="editor-dialog-backdrop"
      role="presentation"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14, ease: "easeOut" }}
    >
      <motion.section
        className="editor-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dirty-dialog-title"
        initial={{ opacity: 0, y: 7, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 5, scale: 0.985 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
      >
        <strong id="dirty-dialog-title">Save changes to “{document.name}”?</strong>
        <p>Your changes will be lost if you close this file without saving.</p>
        <div>
          <button ref={cancelRef} type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={onDiscard}>Don’t Save</button>
          <button className="is-primary" type="button" onClick={onSave}>Save</button>
        </div>
      </motion.section>
    </motion.div>
  );
}

function Editor({
  documents,
  activeDocument,
  workspaceId,
  activePath,
  initializing,
  terminalOpen,
  terminal,
  gitPatch,
  gitHistory,
  githubPanel,
  collaborationPanel,
  readOnly,
  editorRef,
  onSelectDocument,
  onRequestClose,
  onReorderDocuments,
  onChange,
  onNewFile,
  onToggleMaximize,
  onOpenFolder,
  onCloseTerminal,
  onCursorChange,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: {
  documents: OpenDocument[];
  activeDocument: OpenDocument | null;
  workspaceId: string;
  activePath: string | null;
  initializing: boolean;
  terminalOpen: boolean;
  terminal: ReturnType<typeof useTerminalSessions>;
  gitPatch: ReactNode;
  gitHistory: ReactNode;
  githubPanel: ReactNode;
  collaborationPanel: ReactNode;
  readOnly: boolean;
  editorRef: React.RefObject<MonacoEditorHandle | null>;
  onSelectDocument: (path: string) => void;
  onRequestClose: (path: string) => void;
  onReorderDocuments: (draggedPath: string, targetPath: string) => void;
  onChange: (path: string, content: string) => void;
  onNewFile: () => void;
  onToggleMaximize: () => void;
  onOpenFolder: () => void;
  onCloseTerminal: () => void;
  onCursorChange: (position: CursorPosition) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}) {
  return (
    <motion.main
      className="editor-panel panel-surface"
      layout="position"
      transition={{ duration: 0.18, ease: "easeOut" }}
    >
      <Tabs
        documents={documents}
        activePath={activePath}
        onSelect={onSelectDocument}
        onClose={onRequestClose}
        onReorderDocuments={onReorderDocuments}
        onNewFile={onNewFile}
        onToggleMaximize={onToggleMaximize}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onGoBack={onGoBack}
        onGoForward={onGoForward}
      />
      <BreadcrumbBar document={activeDocument} editorRef={editorRef} />
      <div className="editor-stage">
        {activeDocument ? (
          <MonacoEditor
            ref={editorRef}
            workspaceId={workspaceId}
            activePath={activeDocument.path}
            value={activeDocument.content}
            language={activeDocument.language}
            openPaths={documents.map((document) => document.path)}
            readOnly={readOnly || initializing}
            onChange={onChange}
            onCursorChange={onCursorChange}
          />
        ) : (
          <motion.div
            className="editor-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
          >
            {initializing ? <><LoaderCircle />Opening workspace…</> : <button type="button" onClick={onOpenFolder}><FolderOpen />Open Folder</button>}
          </motion.div>
        )}
        <AnimatePresence initial={false}>
          {initializing && activeDocument ? (
            <motion.div
              className="workspace-switch-overlay"
              key="workspace-switch"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
              role="status"
            >
              <span><LoaderCircle />Opening workspace…</span>
            </motion.div>
          ) : null}
          {gitPatch ? (
            <motion.div
              className="editor-overlay-layer editor-overlay-layer--full"
              key="git-patch"
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {gitPatch}
            </motion.div>
          ) : null}
          {githubPanel ? (
            <motion.div
              className="editor-overlay-layer editor-overlay-layer--side"
              key="github-panel"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {githubPanel}
            </motion.div>
          ) : null}
          {collaborationPanel ? (
            <motion.div
              className="editor-overlay-layer editor-overlay-layer--side"
              key="collaboration-panel"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {collaborationPanel}
            </motion.div>
          ) : null}
          {gitHistory ? (
            <motion.div
              className="editor-overlay-layer editor-overlay-layer--side"
              key="git-history"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
            >
              {gitHistory}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <TerminalDrawer open={terminalOpen} terminal={terminal} onClose={onCloseTerminal} />
      </div>
    </motion.main>
  );
}

function Titlebar({
  activeRail,
  workspaceName,
  onSelectRail,
  onOpenFolder,
  onRunWorkspace,
  onWorkspaceActions,
  onAccount,
}: {
  activeRail: RailItem["id"];
  workspaceName: string;
  onSelectRail: (id: RailItem["id"]) => void;
  onOpenFolder: () => void;
  onRunWorkspace: () => void;
  onWorkspaceActions: () => void;
  onAccount: () => void;
}) {
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <div className="window-controls-space">
          <div className="traffic-lights">
            <button type="button" className="traffic-light traffic-light--close" aria-label="Close window" onClick={() => window.collabWindow?.close()} />
            <button type="button" className="traffic-light traffic-light--minimize" aria-label="Minimize window" onClick={() => window.collabWindow?.minimize()} />
            <button type="button" className="traffic-light traffic-light--zoom" aria-label="Zoom window" onClick={() => window.collabWindow?.zoom()} />
          </div>
        </div>
        <div className="primary-toolbar" role="toolbar" aria-label="Workspace views">
          {railItems.map((item) => (
            <IconButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={activeRail === item.id}
              onClick={() => onSelectRail(item.id)}
            />
          ))}
        </div>
        <div className="project-switcher">
          <button type="button" onClick={onOpenFolder} title="Open folder"><Folder aria-hidden="true" /><span>{workspaceName}</span></button>
          <IconButton icon={Plus} label="Add repository" onClick={onOpenFolder} />
        </div>
      </div>

      <div className="titlebar-right">
        <IconButton icon={Play} label="Open workspace terminal" onClick={onRunWorkspace} />
        <IconButton icon={Sparkles} label="Workspace actions" onClick={onWorkspaceActions} />
        <IconButton icon={CircleUserRound} label="GitHub account" onClick={onAccount} />
      </div>
    </header>
  );
}

function LaunchTitlebar() {
  return (
    <header className="launch-titlebar">
      <div className="window-controls-space">
        <div className="traffic-lights">
          <button type="button" className="traffic-light traffic-light--close" aria-label="Close window" onClick={() => window.collabWindow?.close()} />
          <button type="button" className="traffic-light traffic-light--minimize" aria-label="Minimize window" onClick={() => window.collabWindow?.minimize()} />
          <button type="button" className="traffic-light traffic-light--zoom" aria-label="Zoom window" onClick={() => window.collabWindow?.zoom()} />
        </div>
      </div>
      <span className="launch-title">Trace</span>
    </header>
  );
}

function Statusbar({
  branchName,
  terminalOpen,
  mapOpen,
  cursor,
  language,
  onToggleTerminal,
  onToggleMap,
  onOpenBranches,
  onOpenProblems,
  onOpenWorkspaceData,
}: {
  branchName: string;
  terminalOpen: boolean;
  mapOpen: boolean;
  cursor: CursorPosition;
  language?: string;
  onToggleTerminal: () => void;
  onToggleMap: () => void;
  onOpenBranches: () => void;
  onOpenProblems: () => void;
  onOpenWorkspaceData: () => void;
}) {
  return (
    <footer className="statusbar">
      <div className="status-left">
        <button type="button" aria-label={`Current branch: ${branchName}`} onClick={onOpenBranches}><GitBranch />{branchName}</button>
        <button type="button" aria-label="Toggle terminal" aria-pressed={terminalOpen} className={terminalOpen ? "is-active" : ""} onClick={onToggleTerminal}><SquareTerminal /></button>
        <button type="button" aria-label="Go to next problem" title="Next problem" onClick={onOpenProblems}><CircleAlert /></button>
      </div>
      <div className="status-right" title={`Line ${cursor.line}, Column ${cursor.column}${language ? ` · ${language}` : ""}`}>
        <button type="button" aria-label="Toggle Project Map" aria-pressed={mapOpen} className={mapOpen ? "is-active" : ""} onClick={onToggleMap} title="Project Map"><ListTree /></button>
        <button type="button" aria-label="Workspace data" title="Workspace data" onClick={onOpenWorkspaceData}><Database /></button>
        <button type="button" aria-label="No notifications" title="No notifications" disabled><Bell /></button>
      </div>
    </footer>
  );
}

function SidebarLayer({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <motion.div
      className={`sidebar-layer ${active ? "is-active" : ""}`}
      aria-hidden={!active}
      inert={!active}
      animate={{
        opacity: active ? 1 : 0,
        x: active ? 0 : -6,
        transitionEnd: { visibility: active ? "visible" : "hidden" },
      }}
      initial={false}
      transition={{ duration: 0.16, ease: "easeOut" }}
      style={{ pointerEvents: active ? "auto" : "none" }}
    >
      {children}
    </motion.div>
  );
}

export default function App() {
  const [launchView, setLaunchView] = useState<TraceLaunchView>("checking");
  const editor = useWorkspaceEditor({ commandsEnabled: launchView === "workspace" });
  const editorRef = useRef<MonacoEditorHandle | null>(null);
  const [activeRail, setActiveRail] = useState<RailItem["id"]>("files");
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [editorMaximized, setEditorMaximized] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null);
  const [windowClosePending, setWindowClosePending] = useState(false);
  const [patchOpen, setPatchOpen] = useState(false);
  const [patchDiff, setPatchDiff] = useState<GitFileDiff | null>(null);
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [gitMessage, setGitMessage] = useState<string | null>(null);
  const [repositoryView, setRepositoryView] = useState<GitHubRepositoryView>("pull-requests");
  const [branchQuery, setBranchQuery] = useState("");
  const [selectedPullRequestNumber, setSelectedPullRequestNumber] = useState<number | null>(null);
  const [selectedIssueNumber, setSelectedIssueNumber] = useState<number | null>(null);
  const [selectedReviewThreadId, setSelectedReviewThreadId] = useState<string | null>(null);
  const [pendingReviewFocus, setPendingReviewFocus] = useState<PendingReviewFocus | null>(null);
  const [githubMessage, setGitHubMessage] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [draftAnnotationAnchor, setDraftAnnotationAnchor] = useState<AnnotationAnchor | null>(null);
  const [pendingAnnotationFocus, setPendingAnnotationFocus] = useState<PendingAnnotationFocus | null>(null);
  const [collaborationMessage, setCollaborationMessage] = useState<string | null>(null);
  const [pendingSearchFocus, setPendingSearchFocus] = useState<PendingSearchFocus | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!traceAccountApi) {
      setLaunchView("onboarding");
      return undefined;
    }
    void traceAccountApi.state()
      .then((state) => {
        if (!cancelled) setLaunchView(launchViewForAccount(state.user));
      })
      .catch(() => {
        if (!cancelled) setLaunchView("onboarding");
      });
    return () => { cancelled = true; };
  }, []);

  const continueLocally = () => {
    setLaunchView("workspace");
    if (!editor.workspace) void editor.openFolder();
  };
  const searchFocusRequestRef = useRef(0);
  const [navigationHistory, setNavigationHistory] = useState<NavigationHistory>({
    workspaceId: null,
    entries: [],
    index: -1,
  });
  const navigationHistoryRef = useRef(navigationHistory);
  const navigationRequestRef = useRef(0);
  const pendingNavigationRef = useRef<{
    requestId: number;
    workspaceId: string;
    path: string;
    index: number;
  } | null>(null);
  const latestDocumentContentRef = useRef(new Map<string, string>());
  const pendingTypingAuthorizationRef = useRef(new Map<string, { baseContent: string }>());
  const handledWindowCloseTokenRef = useRef(0);
  const workspaceIdRef = useRef(editor.workspace?.id ?? null);
  const collaborationApiForWorkspace = useMemo<CollaborationApi>(() => {
    const demoRequested = import.meta.env.DEV &&
      new URLSearchParams(window.location.search).get("collaborationDemo") === "1";
    return demoRequested ? new DemoCollaborationApi({ localName: "You" }) : collaborationApi;
  }, []);
  const terminal = useTerminalSessions(editor.workspace?.id ?? null, terminalOpen);
  const git = useGitWorkspace(editor.workspace?.id ?? null, {
    branches: activeRail === "branches" || mapOpen,
    history: mapOpen,
    historyLimit: 100,
  });
  const github = useGitHubWorkspace(editor.workspace?.id ?? null, {
    pullRequests: (activeRail === "branches" && repositoryView === "pull-requests") || selectedPullRequestNumber !== null,
    issues: (activeRail === "branches" && repositoryView === "issues") || selectedIssueNumber !== null,
  });
  const collaboration = useCollaborationWorkspace(editor.workspace?.id ?? null, {
    api: collaborationApiForWorkspace,
  });

  workspaceIdRef.current = editor.workspace?.id ?? null;
  navigationHistoryRef.current = navigationHistory;
  if (editor.workspace) {
    for (const document of editor.documents) {
      const key = `${editor.workspace.id}\0${document.path}`;
      if (!pendingTypingAuthorizationRef.current.has(key)) {
        latestDocumentContentRef.current.set(key, document.content);
      }
    }
  }
  const gitMutationBusy = git.busy.has("stage") ||
    git.busy.has("unstage") ||
    git.busy.has("commit") ||
    git.busy.has("checkout-branch") ||
    git.busy.has("create-branch");

  const pendingCloseDocument = editor.documents.find((document) => document.path === pendingClosePath) ?? null;
  const noticeDocument = editor.notice?.documentPath
    ? editor.documents.find((document) => document.path === editor.notice?.documentPath) ?? null
    : null;
  const selectedAnnotation = collaboration.annotations.find(
    (annotation) => annotation.id === selectedAnnotationId,
  ) ?? null;
  const collaborationReadOnly = Boolean(editor.workspace) &&
    collaboration.source !== "unavailable" &&
    !collaboration.writerControl?.ownerIsLocal;

  const updateEditorDocument = (path: string, content: string) => {
    const workspaceId = workspaceIdRef.current;
    if (!workspaceId) return;
    const key = `${workspaceId}\0${path}`;
    const previousContent = latestDocumentContentRef.current.get(key) ??
      editor.documents.find((document) => document.path === path)?.content ??
      "";
    let authorization = pendingTypingAuthorizationRef.current.get(key);
    const shouldAuthorize = collaboration.source !== "unavailable" && !authorization;
    if (shouldAuthorize) {
      authorization = { baseContent: previousContent };
      pendingTypingAuthorizationRef.current.set(key, authorization);
    }

    latestDocumentContentRef.current.set(key, content);
    editor.updateDocument(path, content);
    if (!shouldAuthorize || !authorization) return;

    void collaboration.markTyping().then((writerControl) => {
      if (pendingTypingAuthorizationRef.current.get(key) !== authorization) return;
      pendingTypingAuthorizationRef.current.delete(key);
      if (writerControl?.ownerIsLocal) return;

      latestDocumentContentRef.current.set(key, authorization.baseContent);
      editor.updateDocument(path, authorization.baseContent);
      setCollaborationMessage(
        "Editor control changed before that edit was accepted. Your local buffer was restored.",
      );
      void collaboration.refresh();
    });
  };

  const navigateHistory = (direction: -1 | 1) => {
    const history = navigationHistoryRef.current;
    if (history.workspaceId !== (workspaceIdRef.current ?? null)) return;
    const pending = pendingNavigationRef.current;
    const baseIndex = pending?.workspaceId === history.workspaceId
      ? pending.index
      : history.index;
    const nextIndex = baseIndex + direction;
    const path = history.entries[nextIndex];
    const workspaceId = workspaceIdRef.current;
    if (!path || !workspaceId) return;
    const requestId = ++navigationRequestRef.current;
    pendingNavigationRef.current = { requestId, workspaceId, path, index: nextIndex };
    setPendingSearchFocus(null);
    void editor.openFile(path).then((activated) => {
      const pending = pendingNavigationRef.current;
      if (!pending || pending.requestId !== requestId) return;
      pendingNavigationRef.current = null;
      const current = navigationHistoryRef.current;
      if (
        !activated ||
        current.workspaceId !== workspaceId ||
        current.entries[nextIndex] !== path
      ) return;
      const next = { ...current, index: nextIndex };
      navigationHistoryRef.current = next;
      setNavigationHistory(next);
    });
  };

  const requestClose = (path: string) => {
    const document = editor.documents.find((item) => item.path === path);
    if (!document) return;
    if (document.content !== document.savedContent) setPendingClosePath(path);
    else editor.closeDocument(path);
  };

  const finishWindowCloseStep = (closedPath: string) => {
    const nextDirty = editor.documents.find(
      (document) => document.path !== closedPath && document.content !== document.savedContent,
    );
    if (nextDirty) {
      setPendingClosePath(nextDirty.path);
      return;
    }
    setPendingClosePath(null);
    void editor.flushDrafts().then(() => window.collabWindow?.confirmClose());
  };

  const createFile = async (parentPath = "") => {
    const name = window.prompt("New file name");
    if (name?.trim()) await editor.createFile(parentPath, name.trim());
  };

  const createFolder = async (parentPath = "") => {
    const name = window.prompt("New folder name");
    if (name?.trim()) await editor.createFolder(parentPath, name.trim());
  };

  const renameEntry = async (node: WorkspaceTreeNode) => {
    const name = window.prompt("Rename", node.name);
    if (name?.trim() && name.trim() !== node.name) await editor.renameEntry(node.path, name.trim());
  };

  const deleteEntry = async (node: WorkspaceTreeNode) => {
    if (window.confirm(`Delete “${node.name}”? This cannot be undone.`)) await editor.deleteEntry(node.path);
  };

  const closeGitPatch = () => {
    setPatchOpen(false);
    setPatchDiff(null);
    setPatchError(null);
  };

  const openGitFile = (path: string) => {
    setPendingSearchFocus(null);
    setPendingReviewFocus(null);
    editorRef.current?.clearReviewRange();
    closeGitPatch();
    void editor.openFile(path);
  };

  const closePullRequest = () => {
    setSelectedPullRequestNumber(null);
    setSelectedReviewThreadId(null);
    setPendingReviewFocus(null);
    editorRef.current?.clearReviewRange();
    github.clearPullRequest();
  };

  const closeIssue = () => {
    setSelectedIssueNumber(null);
    github.clearIssue();
  };

  const closeAnnotationPanel = () => {
    setSelectedAnnotationId(null);
    setDraftAnnotationAnchor(null);
    setPendingAnnotationFocus(null);
    editorRef.current?.clearReviewRange();
  };

  const openSearchMatch = async (selection: WorkspaceSearchSelection) => {
    const workspaceId = workspaceIdRef.current;
    if (!workspaceId) return;
    const requestId = ++searchFocusRequestRef.current;
    setSearchMessage(null);
    const activated = await editor.openFile(selection.path);
    if (searchFocusRequestRef.current !== requestId || workspaceIdRef.current !== workspaceId) return;
    if (!activated) {
      setPendingSearchFocus(null);
      return;
    }
    closeGitPatch();
    setMapOpen(false);
    closePullRequest();
    closeIssue();
    closeAnnotationPanel();
    setPendingReviewFocus(null);
    setPendingSearchFocus({ workspaceId, requestId, ...selection });
    editorRef.current?.clearReviewRange();
  };

  const selectAnnotation = (annotation: CodeAnnotation) => {
    closeGitPatch();
    setMapOpen(false);
    closePullRequest();
    closeIssue();
    setDraftAnnotationAnchor(null);
    setSelectedAnnotationId(annotation.id);
    setCollaborationMessage(null);
    setPendingSearchFocus(null);
    setSearchMessage(null);
  };

  const focusAnnotationAnchor = async (anchor: AnnotationAnchor) => {
    const workspaceId = workspaceIdRef.current;
    const localHead = git.status?.branch.oid ?? null;
    if (!workspaceId) return;
    if (
      anchor.revision &&
      (!localHead || anchor.revision.toLocaleLowerCase() !== localHead.toLocaleLowerCase())
    ) {
      setCollaborationMessage(
        "This annotation belongs to another revision. Check out its commit before highlighting it in local code.",
      );
      return;
    }

    setCollaborationMessage(null);
    setPendingReviewFocus(null);
    setPendingAnnotationFocus({ workspaceId, ...anchor });
    editorRef.current?.clearReviewRange();
    await editor.openFile(anchor.path);
  };

  const focusAnnotation = (annotation: CodeAnnotation) => {
    setDraftAnnotationAnchor(null);
    setSelectedAnnotationId(annotation.id);
    void focusAnnotationAnchor(annotation.anchor);
  };

  const startAnnotation = async () => {
    const path = editor.activePath;
    const document = editor.activeDocument;
    if (!path || !document || document.path !== path) {
      setCollaborationMessage("Open a file before leaving an annotation.");
      return;
    }
    const selection = editorRef.current?.getSelectionRange();
    const startLine = selection?.startLine ?? cursor.line;
    const endLine = selection?.endLine ?? startLine;
    const contentHash = await hashTextContent(document.content);
    if (workspaceIdRef.current !== editor.workspace?.id) return;
    closeGitPatch();
    setMapOpen(false);
    closePullRequest();
    closeIssue();
    setSelectedAnnotationId(null);
    setDraftAnnotationAnchor({
      path,
      startLine,
      endLine,
      revision: git.status?.branch.oid ?? null,
      contentHash,
    });
    setCollaborationMessage(null);
  };

  const createAnnotation = async (anchor: AnnotationAnchor, body: string) => {
    const annotation = await collaboration.createAnnotation(anchor, body);
    if (annotation) {
      setDraftAnnotationAnchor(null);
      setSelectedAnnotationId(annotation.id);
    }
    return annotation;
  };

  const openPullRequest = (pullRequest: GitHubPullRequestSummary) => {
    closeAnnotationPanel();
    closeGitPatch();
    setMapOpen(false);
    closeIssue();
    setSelectedReviewThreadId(null);
    setSelectedPullRequestNumber(pullRequest.number);
    setGitHubMessage(null);
    void github.loadPullRequest(pullRequest.number);
  };

  const openIssue = (issue: GitHubIssueSummary) => {
    closeAnnotationPanel();
    closeGitPatch();
    setMapOpen(false);
    closePullRequest();
    setSelectedIssueNumber(issue.number);
    setGitHubMessage(null);
    void github.loadIssue(issue.number);
  };

  const selectReviewThread = (thread: GitHubReviewThread) => {
    setSelectedReviewThreadId(thread.id);
  };

  const focusReviewAnchor = async (anchor: GitHubReviewAnchor) => {
    const workspaceId = workspaceIdRef.current;
    const pullRequest = github.pullRequest;
    const localHead = git.status?.branch.oid;
    editorRef.current?.clearReviewRange();
    setPendingReviewFocus(null);

    if (!workspaceId || !pullRequest) return;
    if (anchor.outdated || anchor.side !== "RIGHT") {
      setGitHubMessage("This feedback targets an older side of the diff. Open the pull request on GitHub to view it safely.");
      return;
    }
    if (
      !localHead ||
      localHead.toLocaleLowerCase() !== pullRequest.headOid.toLocaleLowerCase() ||
      anchor.commitOid.toLocaleLowerCase() !== pullRequest.headOid.toLocaleLowerCase()
    ) {
      setGitHubMessage("This feedback belongs to another revision. Check out the pull request head before highlighting it in local code.");
      return;
    }

    setGitHubMessage(null);
    setPendingReviewFocus({
      workspaceId,
      path: anchor.path,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
    });
    await editor.openFile(anchor.path);
  };

  const openPullRequestFile = (file: GitHubPullRequestFile) => {
    const pullRequest = github.pullRequest;
    const localHead = git.status?.branch.oid;
    if (!pullRequest || !localHead || localHead.toLocaleLowerCase() !== pullRequest.headOid.toLocaleLowerCase()) {
      setGitHubMessage("Check out the pull request head before opening its changed files in the local editor.");
      return;
    }
    if (file.status === "removed") {
      setGitHubMessage("This file was removed by the pull request. Open the pull request on GitHub to inspect its diff.");
      return;
    }
    setGitHubMessage(null);
    openGitFile(file.path);
  };

  const changeRepositoryView = (view: GitHubRepositoryView) => {
    setRepositoryView(view);
    setGitHubMessage(null);
    if (view !== "pull-requests") closePullRequest();
    if (view !== "issues") closeIssue();
  };

  const openPatch = async (file: GitFileStatus, mode: "working" | "staged") => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId) return null;
    setPatchError(null);
    setPatchLoading(true);
    const result = await git.getDiff({ path: file.path, mode });
    if (workspaceIdRef.current !== targetWorkspaceId) return null;
    setPatchLoading(false);
    if (result) {
      closeAnnotationPanel();
      closePullRequest();
      closeIssue();
      setMapOpen(false);
      setPatchDiff(result);
      setPatchOpen(true);
    } else {
      setPatchError("The selected changes could not be loaded.");
      setPatchOpen(true);
    }
    return result;
  };

  const stagePaths = async (paths: string[]) => {
    const dirty = editor.documents.find(
      (document) => paths.includes(document.path) && document.content !== document.savedContent,
    );
    if (dirty) {
      setGitMessage(`Save “${dirty.name}” before staging so Git uses the version you see.`);
      return null;
    }
    const result = await git.stage(paths);
    if (result && patchDiff?.mode === "working" && paths.includes(patchDiff.path)) {
      closeGitPatch();
    }
    return result;
  };

  const unstagePaths = async (paths: string[]) => {
    const result = await git.unstage(paths);
    if (result && patchDiff?.mode === "staged" && paths.includes(patchDiff.path)) {
      closeGitPatch();
    }
    return result;
  };

  const commitChanges = async (message: string) => {
    const result = await git.commit(message);
    if (result) closeGitPatch();
    return result;
  };

  const switchBranch = async (name: string, create = false) => {
    const dirty = editor.documents.find((document) => document.content !== document.savedContent);
    if (dirty) {
      setGitMessage(`Save or close “${dirty.name}” before switching branches.`);
      return null;
    }
    const result = create ? await git.createBranch(name) : await git.checkoutBranch(name);
    if (result) {
      closeGitPatch();
      void editor.refreshTree();
    }
    return result;
  };

  useEffect(() => {
    const workspaceId = editor.workspace?.id ?? null;
    const path = editor.activePath;
    setNavigationHistory((current) => {
      if (current.workspaceId !== workspaceId) {
        return {
          workspaceId,
          entries: path ? [path] : [],
          index: path ? 0 : -1,
        };
      }
      if (!path || current.entries[current.index] === path) return current;
      const pending = pendingNavigationRef.current;
      if (pending?.workspaceId === workspaceId && pending.path === path) return current;
      const entries = current.entries.slice(0, current.index + 1);
      if (entries.at(-1) !== path) entries.push(path);
      const boundedEntries = entries.slice(-100);
      return { workspaceId, entries: boundedEntries, index: boundedEntries.length - 1 };
    });
  }, [editor.activePath, editor.workspace?.id]);

  useEffect(() => {
    navigationRequestRef.current += 1;
    pendingNavigationRef.current = null;
    latestDocumentContentRef.current.clear();
    pendingTypingAuthorizationRef.current.clear();
    setPatchOpen(false);
    setPatchDiff(null);
    setPatchError(null);
    setSelectedCommitHash(null);
    setGitMessage(null);
    setSelectedPullRequestNumber(null);
    setSelectedIssueNumber(null);
    setSelectedReviewThreadId(null);
    setPendingReviewFocus(null);
    setGitHubMessage(null);
    setSelectedAnnotationId(null);
    setDraftAnnotationAnchor(null);
    setPendingAnnotationFocus(null);
    setCollaborationMessage(null);
    setPendingSearchFocus(null);
    setSearchMessage(null);
    setBranchQuery("");
    editorRef.current?.clearReviewRange();
  }, [editor.workspace?.id]);

  useEffect(() => {
    if (
      !pendingSearchFocus ||
      editor.workspace?.id !== pendingSearchFocus.workspaceId ||
      editor.activePath !== pendingSearchFocus.path
    ) return;
    const document = editor.activeDocument;
    if (!document || document.path !== pendingSearchFocus.path) return;
    const line = document.content.split(/\r?\n/)[pendingSearchFocus.line - 1] ?? "";
    const matchedText = line.slice(pendingSearchFocus.column - 1, pendingSearchFocus.endColumn - 1);
    const stillMatches = pendingSearchFocus.caseSensitive
      ? matchedText === pendingSearchFocus.query
      : matchedText.toLocaleLowerCase() === pendingSearchFocus.query.toLocaleLowerCase();
    if (!stillMatches) {
      setPendingSearchFocus(null);
      setSearchMessage("That result changed after the search. Run the search again to refresh its location.");
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.focusTextRange({
        startLine: pendingSearchFocus.line,
        startColumn: pendingSearchFocus.column,
        endColumn: pendingSearchFocus.endColumn,
      });
      setPendingSearchFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor.activeDocument, editor.activePath, editor.workspace?.id, pendingSearchFocus]);

  useEffect(() => {
    if (
      !pendingReviewFocus ||
      editor.workspace?.id !== pendingReviewFocus.workspaceId ||
      editor.activePath !== pendingReviewFocus.path
    ) return;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.focusReviewRange({
        startLine: pendingReviewFocus.startLine,
        endLine: pendingReviewFocus.endLine,
      });
      setPendingReviewFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor.activePath, editor.workspace?.id, pendingReviewFocus]);

  useEffect(() => {
    if (
      !pendingAnnotationFocus ||
      editor.workspace?.id !== pendingAnnotationFocus.workspaceId ||
      editor.activePath !== pendingAnnotationFocus.path
    ) return;
    const document = editor.activeDocument;
    if (!document || document.path !== pendingAnnotationFocus.path) return;
    let cancelled = false;
    let frame: number | null = null;
    void (async () => {
      if (pendingAnnotationFocus.contentHash) {
        const currentHash = await hashTextContent(document.content);
        if (cancelled) return;
        if (currentHash !== pendingAnnotationFocus.contentHash) {
          setPendingAnnotationFocus(null);
          setCollaborationMessage(
            "This file changed after the annotation was created, so its old line range was not highlighted.",
          );
          return;
        }
      }
      frame = window.requestAnimationFrame(() => {
        editorRef.current?.focusReviewRange({
          startLine: pendingAnnotationFocus.startLine,
          endLine: pendingAnnotationFocus.endLine,
        });
        setPendingAnnotationFocus(null);
      });
    })();
    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editor.activeDocument, editor.activePath, editor.workspace?.id, pendingAnnotationFocus]);

  useEffect(() => {
    if (selectedAnnotationId && !selectedAnnotation && !collaboration.loading) {
      setSelectedAnnotationId(null);
    }
  }, [collaboration.loading, selectedAnnotation, selectedAnnotationId]);

  const shortcutContext = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : document.activeElement;
    const terminalDrawer = document.querySelector(".terminal-drawer");
    return {
      terminalFocused: Boolean(element && terminalDrawer?.contains(element)),
      gitFocused: Boolean(element?.closest(".git-sidebar, .git-patch-panel, .git-sidebar-dialog")),
      githubFocused: Boolean(element?.closest(".github-repository-sidebar, .github-detail-panel")),
      collaborationFocused: Boolean(element?.closest(".collab-sidebar, .collab-annotation-panel")),
    };
  };

  const handleSaveShortcut = (target: EventTarget | null) => {
    const context = shortcutContext(target);
    if (
      context.terminalFocused ||
      context.gitFocused ||
      context.githubFocused ||
      context.collaborationFocused
    ) return;
    void editor.saveDocument();
  };

  const handleCloseShortcut = (target: EventTarget | null) => {
    const context = shortcutContext(target);
    if (context.terminalFocused) {
      setTerminalOpen(false);
      return;
    }
    if (selectedAnnotationId !== null || draftAnnotationAnchor !== null) {
      closeAnnotationPanel();
      return;
    }
    if (selectedPullRequestNumber !== null) {
      closePullRequest();
      return;
    }
    if (selectedIssueNumber !== null) {
      closeIssue();
      return;
    }
    if (patchOpen) {
      closeGitPatch();
      return;
    }
    if (context.gitFocused || context.githubFocused || context.collaborationFocused) return;
    if (editor.activePath) requestClose(editor.activePath);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (launchView !== "workspace") return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const nativeMenuOwnsShortcut = Boolean(window.collabWorkspace) && command && (
        (!event.shiftKey && ["p", "o", "s", "w", "j"].includes(key)) ||
        (event.shiftKey && (key === "f" || key === "p")) ||
        (!event.shiftKey && (event.key === "[" || event.key === "]"))
      );
      if (nativeMenuOwnsShortcut) return;
      if (command && !event.shiftKey && key === "p") {
        event.preventDefault();
        setQuickOpen(true);
      }
      if (command && event.shiftKey && key === "p") {
        event.preventDefault();
        editorRef.current?.openCommandPalette();
      }
      if (command && event.shiftKey && key === "f") {
        event.preventDefault();
        setActiveRail("search");
      }
      if (command && !event.shiftKey && event.key === "[") {
        event.preventDefault();
        navigateHistory(-1);
      }
      if (command && !event.shiftKey && event.key === "]") {
        event.preventDefault();
        navigateHistory(1);
      }
      if (command && !event.shiftKey && key === "o") {
        event.preventDefault();
        void editor.openFolder();
      }
      if (command && !event.shiftKey && key === "s") {
        event.preventDefault();
        handleSaveShortcut(event.target);
      }
      if (command && !event.shiftKey && key === "w") {
        event.preventDefault();
        handleCloseShortcut(event.target);
      }
      if (command && !event.shiftKey && key === "j") {
        event.preventDefault();
        setTerminalOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  });

  useEffect(() => {
    const dispose = window.collabWorkspace?.onCommand((payload) => {
      const command = typeof payload === "string" ? payload : payload.command;
      if (launchView !== "workspace") return;
      if (command === "quick-open") setQuickOpen(true);
      if (command === "workspace-search") setActiveRail("search");
      if (command === "navigate-back") navigateHistory(-1);
      if (command === "navigate-forward") navigateHistory(1);
      if (command === "save") handleSaveShortcut(document.activeElement);
      if (command === "close-editor") handleCloseShortcut(document.activeElement);
      if (command === "toggle-terminal") setTerminalOpen((value) => !value);
      if (command === "open-terminal") setTerminalOpen(true);
      if (command === "open-collaboration") setActiveRail("workspace");
      if (command === "editor-commands") editorRef.current?.openCommandPalette();
      if (command === "language-support") setActiveRail("extensions");
      if (command === "new-terminal") {
        setTerminalOpen(true);
        void terminal.createSession();
      }
      if (command === "kill-terminal" && terminal.activeSessionId) {
        void terminal.closeSession(terminal.activeSessionId);
      }
    });
    return typeof dispose === "function" ? dispose : undefined;
  });

  useEffect(() => {
    if (editor.notice?.tone !== "info") return;
    const id = window.setTimeout(editor.dismissNotice, 1600);
    return () => window.clearTimeout(id);
  }, [editor.notice, editor.dismissNotice]);

  useEffect(() => {
    if (
      editor.windowCloseRequestToken === 0 ||
      editor.windowCloseRequestToken === handledWindowCloseTokenRef.current
    ) return;
    handledWindowCloseTokenRef.current = editor.windowCloseRequestToken;
    setWindowClosePending(true);
    void editor.flushDrafts().then(() => {
      if (pendingClosePath) return;
      const firstDirty = editor.documents.find(
        (document) => document.content !== document.savedContent,
      );
      if (firstDirty) setPendingClosePath(firstDirty.path);
      else window.collabWindow?.confirmClose();
    });
  }, [editor.windowCloseRequestToken]);

  if (launchView !== "workspace") {
    return (
      <MotionConfig reducedMotion="user">
        <div className="app-window app-window--onboarding">
          <LaunchTitlebar />
          <main className="onboarding-stage">
            {launchView === "checking" ? (
              <div className="launch-loading" role="status"><LoaderCircle />Checking your Trace session…</div>
            ) : (
              <Onboarding onContinueLocal={continueLocally} />
            )}
          </main>
        </div>
      </MotionConfig>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
    <div className="app-window">
      <Titlebar
        activeRail={activeRail}
        workspaceName={editor.workspace?.name ?? "trace"}
        onSelectRail={setActiveRail}
        onOpenFolder={() => void editor.openFolder()}
        onRunWorkspace={() => setTerminalOpen(true)}
        onWorkspaceActions={() => editorRef.current?.openCommandPalette()}
        onAccount={() => {
          setRepositoryView("pull-requests");
          setActiveRail("branches");
        }}
      />
      <motion.div
        className={`workbench ${editorMaximized ? "is-editor-maximized" : ""}`}
        layout
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <motion.div
          className="sidebar-viewport"
          layout="position"
          aria-hidden={editorMaximized}
          inert={editorMaximized}
          animate={{ opacity: editorMaximized ? 0 : 1, x: editorMaximized ? -10 : 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          style={{ pointerEvents: editorMaximized ? "none" : "auto" }}
        >
          <SidebarLayer active={activeRail === "files"}>
            <Sidebar
              workspaceName={editor.workspace?.name ?? "trace"}
              tree={editor.tree}
              activePath={editor.activePath}
              loadingPaths={editor.loadingPaths}
              onOpenFile={openGitFile}
              onOpenFolder={() => void editor.openFolder()}
              onRefresh={() => void editor.refreshTree()}
              onNewFile={(parentPath) => void createFile(parentPath)}
              onNewFolder={(parentPath) => void createFolder(parentPath)}
              onRename={(node) => void renameEntry(node)}
              onDelete={(node) => void deleteEntry(node)}
            />
          </SidebarLayer>
          <SidebarLayer active={activeRail === "search"}>
            <SearchSidebar
              workspaceId={editor.workspace?.id ?? null}
              workspaceName={editor.workspace?.name ?? "trace"}
              activePath={editor.activePath}
              onOpenMatch={(selection) => void openSearchMatch(selection)}
            />
          </SidebarLayer>
          <SidebarLayer active={activeRail === "source"}>
            <SourceControlSidebar
              repositoryName={editor.workspace?.name ?? "trace"}
              status={git.status}
              loading={git.loading.status}
              busy={gitMutationBusy}
              notRepository={git.notRepository}
              error={git.notRepository ? null : git.error?.message ?? null}
              onRefresh={git.refreshStatus}
              onOpenFile={openGitFile}
              onOpenPatch={openPatch}
              onStage={stagePaths}
              onUnstage={unstagePaths}
              onCommit={commitChanges}
            />
          </SidebarLayer>
          <SidebarLayer active={activeRail === "branches"}>
            <RepositorySidebar
              repositoryName={editor.workspace?.name ?? "trace"}
              activeView={repositoryView}
              onActiveViewChange={changeRepositoryView}
              github={github}
              selectedPullRequestNumber={selectedPullRequestNumber}
              selectedIssueNumber={selectedIssueNumber}
              branchQuery={branchQuery}
              onBranchQueryChange={setBranchQuery}
              onRefreshBranches={async () => { await git.refreshBranches(); }}
              onSelectPullRequest={openPullRequest}
              onSelectIssue={openIssue}
              branchesView={(
                <BranchesView
                  branches={git.branches}
                  query={branchQuery}
                  loading={git.loading.branches}
                  busy={gitMutationBusy}
                  notRepository={git.notRepository}
                  error={git.notRepository ? null : git.error?.message ?? null}
                  onRefresh={git.refreshBranches}
                  onCheckout={(name) => switchBranch(name)}
                  onCreate={(name) => switchBranch(name, true)}
                />
              )}
            />
          </SidebarLayer>
          <SidebarLayer active={activeRail === "workspace"}>
            <CollaborationSidebar
              workspaceName={editor.workspace?.name ?? "trace"}
              collaboration={collaboration}
              activePath={editor.activePath}
              selectedAnnotationId={selectedAnnotationId}
              onSelectAnnotation={selectAnnotation}
              onFocusAnnotation={focusAnnotation}
              onStartAnnotation={startAnnotation}
              onInviteMember={() => setCollaborationMessage(
                "Workspace invitations will activate when this folder is connected to a cloud room.",
              )}
            />
          </SidebarLayer>
          <SidebarLayer active={activeRail === "extensions"}>
            <LanguageSupportSidebar />
          </SidebarLayer>
        </motion.div>
        <motion.div
          className="splitter"
          aria-hidden="true"
          animate={{ opacity: editorMaximized ? 0 : 1, scaleX: editorMaximized ? 0.5 : 1 }}
          transition={{ duration: 0.14, ease: "easeOut" }}
        >
          <span />
        </motion.div>
        <Editor
          documents={editor.documents}
          activeDocument={editor.activeDocument}
          workspaceId={editor.workspace?.id ?? "trace"}
          activePath={editor.activePath}
          initializing={editor.initializing}
          terminalOpen={terminalOpen}
          terminal={terminal}
          gitPatch={patchOpen ? (
            <GitPatchPanel
              diff={patchDiff}
              loading={patchLoading || git.busy.has("diff")}
              error={patchError ?? (git.error?.operation === "diff" ? git.error.message : null)}
              onClose={closeGitPatch}
              onOpenFile={openGitFile}
            />
          ) : null}
          gitHistory={mapOpen ? (
            <GitHistoryPanel
              repositoryName={editor.workspace?.name ?? "trace"}
              history={git.history}
              branches={git.branches}
              loading={git.loading.history}
              notRepository={git.notRepository}
              error={
                !git.notRepository && git.error?.operation === "history"
                  ? git.error.message
                  : null
              }
              selectedHash={selectedCommitHash}
              onClose={() => setMapOpen(false)}
              onRefresh={git.refreshHistory}
              onSelectCommit={(commit) => setSelectedCommitHash(commit.hash)}
              onLoadMore={() => git.refreshHistory({
                maxCount: Math.min((git.history?.commits.length ?? 100) + 50, 200),
              })}
            />
          ) : null}
          githubPanel={selectedPullRequestNumber !== null ? (
            <PullRequestPanel
              pullRequest={github.pullRequest?.number === selectedPullRequestNumber ? github.pullRequest : null}
              loading={github.loading.pullRequest}
              error={github.errors["pull-request"]?.message ?? null}
              selectedThreadId={selectedReviewThreadId}
              onClose={closePullRequest}
              onRetry={() => github.loadPullRequest(selectedPullRequestNumber)}
              onSelectThread={selectReviewThread}
              onSelectReviewAnchor={(anchor) => void focusReviewAnchor(anchor)}
              onSelectFile={openPullRequestFile}
            />
          ) : selectedIssueNumber !== null ? (
            <IssuePanel
              issue={github.issue?.number === selectedIssueNumber ? github.issue : null}
              loading={github.loading.issue}
              error={github.errors.issue?.message ?? null}
              onClose={closeIssue}
              onRetry={() => github.loadIssue(selectedIssueNumber)}
            />
          ) : null}
          collaborationPanel={selectedAnnotationId !== null || draftAnnotationAnchor !== null ? (
            <AnnotationPanel
              annotation={selectedAnnotation}
              draftAnchor={draftAnnotationAnchor}
              loading={collaboration.loading}
              busy={
                collaboration.busy.has("create-annotation") ||
                collaboration.busy.has("reply-annotation") ||
                collaboration.busy.has("resolve-annotation")
              }
              error={collaboration.error?.message ?? null}
              canCompose={collaboration.snapshot?.connection !== "unavailable"}
              onClose={closeAnnotationPanel}
              onFocusAnchor={(anchor) => void focusAnnotationAnchor(anchor)}
              onCreate={createAnnotation}
              onReply={collaboration.replyAnnotation}
              onResolve={collaboration.resolveAnnotation}
            />
          ) : null}
          readOnly={collaborationReadOnly}
          editorRef={editorRef}
          onSelectDocument={editor.selectDocument}
          onRequestClose={requestClose}
          onReorderDocuments={editor.reorderDocuments}
          onChange={updateEditorDocument}
          onNewFile={() => void createFile("")}
          onToggleMaximize={() => setEditorMaximized((value) => !value)}
          onOpenFolder={() => void editor.openFolder()}
          onCloseTerminal={() => setTerminalOpen(false)}
          onCursorChange={setCursor}
          canGoBack={navigationHistory.workspaceId === (editor.workspace?.id ?? null) && navigationHistory.index > 0}
          canGoForward={
            navigationHistory.workspaceId === (editor.workspace?.id ?? null) &&
            navigationHistory.index >= 0 &&
            navigationHistory.index < navigationHistory.entries.length - 1
          }
          onGoBack={() => navigateHistory(-1)}
          onGoForward={() => navigateHistory(1)}
        />
      </motion.div>
      <Statusbar
        branchName={git.status?.branch.detached
          ? `detached ${git.status.branch.oid?.slice(0, 7) ?? ""}`.trim()
          : git.status?.branch.current ?? "main"}
        terminalOpen={terminalOpen}
        mapOpen={mapOpen}
        cursor={cursor}
        language={editor.activeDocument?.language}
        onToggleTerminal={() => setTerminalOpen((value) => !value)}
        onToggleMap={() => {
          if (!mapOpen) {
            closeAnnotationPanel();
            closePullRequest();
            closeIssue();
            closeGitPatch();
          }
          setMapOpen((value) => !value);
        }}
        onOpenBranches={() => setActiveRail("branches")}
        onOpenProblems={() => editorRef.current?.goToNextProblem()}
        onOpenWorkspaceData={() => setActiveRail("workspace")}
      />

      <div className="notice-stack" aria-live="polite">
        <AnimatePresence initial={false} mode="popLayout">
          {editor.notice ? (
            <motion.div
              className={`editor-notice editor-notice--${editor.notice.tone}`}
              key="editor-notice"
              role="status"
              layout="position"
              initial={{ opacity: 0, y: 6, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.985 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <span>{editor.notice.message}</span>
              {noticeDocument?.externalConflict ? (
                <>
                  {!noticeDocument.deleted ? (
                    <button type="button" onClick={() => void editor.reloadDocument(noticeDocument.path)}>Reload</button>
                  ) : null}
                  <button type="button" onClick={() => void editor.saveDocument(noticeDocument.path, true)}>Keep Mine</button>
                </>
              ) : null}
              <IconButton icon={X} label="Dismiss" onClick={editor.dismissNotice} />
            </motion.div>
          ) : null}

          {gitMessage ? (
            <motion.div
              className="editor-notice editor-notice--warning"
              key="git-notice"
              role="status"
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <span>{gitMessage}</span>
              <IconButton icon={X} label="Dismiss" onClick={() => setGitMessage(null)} />
            </motion.div>
          ) : null}

          {githubMessage ? (
            <motion.div
              className="editor-notice editor-notice--warning"
              key="github-notice"
              role="status"
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <span>{githubMessage}</span>
              <IconButton icon={X} label="Dismiss" onClick={() => setGitHubMessage(null)} />
            </motion.div>
          ) : null}

          {collaborationMessage ? (
            <motion.div
              className="editor-notice editor-notice--warning"
              key="collaboration-notice"
              role="status"
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <span>{collaborationMessage}</span>
              <IconButton icon={X} label="Dismiss" onClick={() => setCollaborationMessage(null)} />
            </motion.div>
          ) : null}

          {searchMessage ? (
            <motion.div
              className="editor-notice editor-notice--warning"
              key="search-notice"
              role="status"
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.14, ease: "easeOut" }}
            >
              <span>{searchMessage}</span>
              <IconButton icon={X} label="Dismiss" onClick={() => setSearchMessage(null)} />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {quickOpen ? (
          <QuickOpen tree={editor.tree} onOpen={(path) => void editor.openFile(path)} onClose={() => setQuickOpen(false)} />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {pendingCloseDocument ? (
          <DirtyCloseDialog
            document={pendingCloseDocument}
            onCancel={() => {
              setPendingClosePath(null);
              if (windowClosePending) {
                setWindowClosePending(false);
                window.collabWindow?.cancelClose();
              }
            }}
            onDiscard={() => {
              editor.closeDocument(pendingCloseDocument.path, true);
              if (windowClosePending) finishWindowCloseStep(pendingCloseDocument.path);
              else setPendingClosePath(null);
            }}
            onSave={() => {
              void editor.saveDocument(pendingCloseDocument.path).then((saved) => {
                if (!saved) return;
                editor.closeDocument(pendingCloseDocument.path);
                if (windowClosePending) finishWindowCloseStep(pendingCloseDocument.path);
                else setPendingClosePath(null);
              });
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
