import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CaseSensitive,
  ChevronDown,
  CircleAlert,
  FileCode2,
  FolderSearch2,
  LoaderCircle,
  Search,
  WholeWord,
  X,
} from "lucide-react";
import type { WorkspaceSearchApi, WorkspaceSearchFile, WorkspaceSearchMatch } from "./types";
import { workspaceSearchApi } from "./api";
import { useWorkspaceSearch } from "./useWorkspaceSearch";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export type WorkspaceSearchSelection = WorkspaceSearchMatch & {
  path: string;
  query: string;
  caseSensitive: boolean;
};

export type SearchSidebarProps = {
  workspaceId: string | null;
  workspaceName: string;
  activePath?: string | null;
  api?: WorkspaceSearchApi;
  onOpenMatch: (selection: WorkspaceSearchSelection) => void;
};

function fileName(path: string) {
  return path.split("/").at(-1) ?? path;
}

function parentPath(path: string) {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function ResultPreview({ match }: { match: WorkspaceSearchMatch }) {
  const start = Math.max(0, match.column - match.previewStartColumn);
  const length = Math.max(0, match.endColumn - match.column);
  const end = Math.min(match.preview.length, start + length);
  return (
    <code>
      {match.previewTruncatedStart ? <i aria-hidden="true">…</i> : null}
      <span>{match.preview.slice(0, start)}</span>
      <mark>{match.preview.slice(start, end)}</mark>
      <span>{match.preview.slice(end)}</span>
      {match.previewTruncatedEnd ? <i aria-hidden="true">…</i> : null}
    </code>
  );
}

function SearchFileGroup({
  file,
  activePath,
  collapsed,
  onToggle,
  onOpenMatch,
  query,
  caseSensitive,
}: {
  file: WorkspaceSearchFile;
  activePath: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onOpenMatch: SearchSidebarProps["onOpenMatch"];
  query: string;
  caseSensitive: boolean;
}) {
  const directory = parentPath(file.path);
  const listId = useId();
  return (
    <motion.section
      className={`workspace-search-file ${activePath === file.path ? "is-active-file" : ""}`}
      layout="position"
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={layoutTransition}
    >
      <button type="button" className="workspace-search-file-heading" aria-expanded={!collapsed} aria-controls={listId} onClick={onToggle}>
        <ChevronDown aria-hidden="true" />
        <FileCode2 aria-hidden="true" />
        <span>
          <strong>{fileName(file.path)}</strong>
          {directory ? <small>{directory}</small> : null}
        </span>
        <small>{file.matches.length}</small>
      </button>
      <AnimatePresence initial={false} mode="popLayout">
      {!collapsed ? (
        <motion.div
          className="workspace-search-match-list"
          id={listId}
          key="matches"
          initial={{ opacity: 0, scaleY: 0.98 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.98 }}
          style={{ transformOrigin: "top" }}
          transition={revealTransition}
        >
          <AnimatePresence initial={false} mode="popLayout">
          {file.matches.map((match, index) => (
            <motion.button
              type="button"
              className="workspace-search-match"
              key={`${match.line}:${match.column}:${index}`}
              layout="position"
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={revealTransition}
              title={`${file.path}:${match.line}:${match.column}`}
              onClick={() => onOpenMatch({ path: file.path, query, caseSensitive, ...match })}
            >
              <span>{match.line}</span>
              <ResultPreview match={match} />
            </motion.button>
          ))}
          </AnimatePresence>
        </motion.div>
      ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

export function SearchSidebar({
  workspaceId,
  workspaceName,
  activePath = null,
  api = workspaceSearchApi,
  onOpenMatch,
}: SearchSidebarProps) {
  const search = useWorkspaceSearch(workspaceId, api);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const debounceRef = useRef<number | null>(null);

  const runSearch = () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = null;
    if (!workspaceId || !query) return;
    void search.run(query, { caseSensitive, wholeWord });
  };

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (!workspaceId || !query) {
      void search.cancel();
      search.clear();
      debounceRef.current = null;
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void search.run(query, { caseSensitive, wholeWord });
    }, 180);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [caseSensitive, query, search.cancel, search.clear, search.run, wholeWord, workspaceId]);

  useEffect(() => setCollapsedFiles(new Set()), [search.result?.requestId]);

  const result = search.result;
  const clearQuery = () => {
    setQuery("");
    void search.cancel();
    search.clear();
  };

  return (
    <aside className="sidebar panel-surface workspace-search-sidebar" aria-label="Search workspace" aria-busy={search.loading}>
      <label className="search-field workspace-search-field">
        <Search aria-hidden="true" />
        <input
          value={query}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search"
          aria-label="Search text in workspace"
          onChange={(event) => setQuery(event.target.value.replace(/[\r\n]/g, ""))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              runSearch();
            }
            if (event.key === "Escape" && query) clearQuery();
          }}
        />
        <AnimatePresence initial={false} mode="wait">
        {search.loading ? (
          <motion.button
            key="cancel-search"
            type="button"
            className="sidebar-menu-trigger"
            aria-label="Cancel search"
            title="Cancel search"
            onClick={() => void search.cancel()}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={revealTransition}
          >
            <LoaderCircle className="workspace-search-spin" aria-hidden="true" />
          </motion.button>
        ) : query ? (
          <motion.button
            key="clear-search"
            type="button"
            className="sidebar-menu-trigger"
            aria-label="Clear search"
            title="Clear"
            onClick={clearQuery}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={revealTransition}
          >
            <X aria-hidden="true" />
          </motion.button>
        ) : <motion.span key="search-action-spacer" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition} />}
        </AnimatePresence>
      </label>

      <div className="workspace-search-workspace-row">
        <FolderSearch2 aria-hidden="true" />
        <div>
          <strong>{workspaceName}</strong>
          <span>
            {!workspaceId
              ? "Open a folder to search"
              : result
                ? `${result.matchCount} ${result.matchCount === 1 ? "result" : "results"} in ${result.files.length} ${result.files.length === 1 ? "file" : "files"}`
                : "Workspace text search"}
          </span>
        </div>
      </div>

      <div className="workspace-search-options" role="toolbar" aria-label="Search options">
        <button
          type="button"
          className={caseSensitive ? "is-active" : ""}
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={() => setCaseSensitive((value) => !value)}
        >
          <AnimatePresence initial={false}>
            {caseSensitive ? (
              <motion.span key="case-indicator" className="workspace-search-option-indicator" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={revealTransition} />
            ) : null}
          </AnimatePresence>
          <CaseSensitive aria-hidden="true" />
          Match case
        </button>
        <button
          type="button"
          className={wholeWord ? "is-active" : ""}
          aria-pressed={wholeWord}
          title="Match whole word"
          onClick={() => setWholeWord((value) => !value)}
        >
          <AnimatePresence initial={false}>
            {wholeWord ? (
              <motion.span key="word-indicator" className="workspace-search-option-indicator" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={revealTransition} />
            ) : null}
          </AnimatePresence>
          <WholeWord aria-hidden="true" />
          Whole word
        </button>
      </div>

      <div className="workspace-search-scroll">
        <AnimatePresence initial={false} mode="popLayout">
        {search.error ? (
          <motion.div
            className="workspace-search-message is-error"
            role="status"
            key="search-error"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={revealTransition}
          >
            <CircleAlert aria-hidden="true" />
            <span>{search.error.message}</span>
          </motion.div>
        ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false} mode="wait">
        {!workspaceId ? (
          <motion.div className="workspace-search-empty" key="no-workspace" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <FolderSearch2 aria-hidden="true" />
            <strong>No workspace open</strong>
            <p>Open a folder to search its text files.</p>
          </motion.div>
        ) : !query ? (
          <motion.div className="workspace-search-empty" key="search-prompt" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <Search aria-hidden="true" />
            <strong>Search across files</strong>
            <p>Results include line context and open directly in the editor.</p>
          </motion.div>
        ) : search.loading && !result ? (
          <motion.div className="workspace-search-loading" role="status" key="search-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <LoaderCircle className="workspace-search-spin" aria-hidden="true" />
            <span>Searching workspace…</span>
          </motion.div>
        ) : result && result.matchCount === 0 ? (
          <motion.div className="workspace-search-empty" key="no-results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <Search aria-hidden="true" />
            <strong>No results</strong>
            <p>No text matched “{result.query}”.</p>
          </motion.div>
        ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false} mode="sync">
        {result?.files.map((file) => (
          <SearchFileGroup
            key={file.path}
            file={file}
            activePath={activePath}
            collapsed={collapsedFiles.has(file.path)}
            onToggle={() => setCollapsedFiles((current) => {
              const next = new Set(current);
              if (next.has(file.path)) next.delete(file.path);
              else next.add(file.path);
              return next;
            })}
            onOpenMatch={onOpenMatch}
            query={result.query}
            caseSensitive={result.caseSensitive}
          />
        ))}
        </AnimatePresence>

        <AnimatePresence initial={false} mode="popLayout">
        {result && (result.truncated || result.filesSkipped > 0) ? (
          <motion.div
            className="workspace-search-message"
            role="status"
            key="search-truncated"
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={revealTransition}
          >
            <CircleAlert aria-hidden="true" />
            <span>
              {result.truncated ? "Result limits were reached. Narrow the search to see more." : null}
              {result.truncated && result.filesSkipped > 0 ? " " : null}
              {result.filesSkipped > 0 ? `${result.filesSkipped} binary, large, or unreadable ${result.filesSkipped === 1 ? "file was" : "files were"} skipped.` : null}
            </span>
          </motion.div>
        ) : null}
        </AnimatePresence>
      </div>
      <div className="sidebar-scrollbar" aria-hidden="true"><span /></div>
    </aside>
  );
}
