import { useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileDiff,
  Filter,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import type {
  GitCommitResult,
  GitFileDiff,
  GitFileStatus,
  GitStageResult,
  GitStatus,
} from "../types";

type PatchMode = "working" | "staged";

const revealTransition = { type: "tween" as const, duration: 0.14 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.16,
  layout: { type: "tween" as const, duration: 0.16 },
};

export interface SourceControlSidebarProps {
  repositoryName: string;
  status: GitStatus | null;
  loading?: boolean;
  busy?: boolean;
  notRepository?: boolean;
  error?: string | null;
  onRefresh: () => void | GitStatus | null | Promise<GitStatus | null>;
  onOpenFile: (path: string) => void;
  onOpenPatch: (file: GitFileStatus, mode: PatchMode) => void | GitFileDiff | null | Promise<GitFileDiff | null>;
  onStage: (paths: string[]) => void | GitStageResult | null | Promise<GitStageResult | null>;
  onUnstage: (paths: string[]) => void | GitStageResult | null | Promise<GitStageResult | null>;
  onCommit: (message: string) => void | GitCommitResult | null | Promise<GitCommitResult | null>;
}

type ChangeSectionProps = {
  title: string;
  files: GitFileStatus[];
  mode: PatchMode;
  emptyLabel: string;
  action: "stage" | "unstage";
  busy: boolean;
  onOpenFile: SourceControlSidebarProps["onOpenFile"];
  onOpenPatch: SourceControlSidebarProps["onOpenPatch"];
  onAction: SourceControlSidebarProps["onStage"];
};

function branchLabel(status: GitStatus): string {
  if (status.branch.detached) return status.branch.oid ? `detached ${status.branch.oid.slice(0, 7)}` : "detached";
  if (status.branch.unborn) return status.branch.current ?? "new repository";
  return status.branch.current ?? "no branch";
}

function statusLetter(file: GitFileStatus, mode: PatchMode): string {
  if (file.conflict) return "C";
  if (file.untracked) return "U";
  const code = mode === "staged" ? file.indexStatus : file.worktreeStatus;
  if (code === "A") return "A";
  if (code === "D") return "D";
  if (code === "R") return "R";
  if (code === "C") return "C";
  if (code === "T") return "T";
  return "M";
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function parentPath(path: string): string {
  const segments = path.split("/");
  return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
}

function ChangeSection({
  title,
  files,
  mode,
  emptyLabel,
  action,
  busy,
  onOpenFile,
  onOpenPatch,
  onAction,
}: ChangeSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  const actionLabel = action === "stage" ? "Stage" : "Unstage";
  const ActionIcon = action === "stage" ? Plus : Minus;

  return (
    <motion.section className="git-change-section" layout transition={layoutTransition}>
      <div className="git-section-heading">
        <button
          type="button"
          className="git-section-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDown aria-hidden="true" />
          <span>{title}</span>
          <small>{files.length}</small>
        </button>
        {files.length > 0 ? (
          <button
            type="button"
            className="git-quiet-icon-button"
            aria-label={`${actionLabel} all ${title.toLowerCase()}`}
            title={`${actionLabel} all`}
            disabled={busy}
            onClick={() => void onAction(files.map((file) => file.path))}
          >
            <ActionIcon aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {expanded ? (
        <motion.div
          className="git-change-list"
          id={bodyId}
          key="change-list"
          initial={{ opacity: 0, scaleY: 0.98 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.98 }}
          style={{ transformOrigin: "top" }}
          transition={revealTransition}
        >
          {files.length === 0 ? <p className="git-section-empty">{emptyLabel}</p> : null}
          <AnimatePresence initial={false} mode="popLayout">
          {files.map((file) => {
            const directory = parentPath(file.path);
            return (
              <motion.div
                className="git-change-row"
                key={`${mode}-${file.path}`}
                layout="position"
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={revealTransition}
              >
                <button
                  type="button"
                  className="git-change-file"
                  title={file.path}
                  onClick={() => void onOpenPatch(file, mode)}
                  onDoubleClick={() => onOpenFile(file.path)}
                >
                  <FileDiff aria-hidden="true" />
                  <span className="git-change-name">{fileName(file.path)}</span>
                  {directory ? <small>{directory}</small> : null}
                </button>
                <span
                  className={`git-status-letter git-status-letter--${statusLetter(file, mode).toLowerCase()}`}
                  aria-label={`${statusLetter(file, mode)} status`}
                >
                  {statusLetter(file, mode)}
                </span>
                <button
                  type="button"
                  className="git-change-action"
                  aria-label={`${actionLabel} ${file.path}`}
                  title={`${actionLabel} file`}
                  disabled={busy}
                  onClick={() => void onAction([file.path])}
                >
                  <ActionIcon aria-hidden="true" />
                </button>
              </motion.div>
            );
          })}
          </AnimatePresence>
        </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

export function SourceControlSidebar({
  repositoryName,
  status,
  loading = false,
  busy = false,
  notRepository = false,
  error = null,
  onRefresh,
  onOpenFile,
  onOpenPatch,
  onStage,
  onUnstage,
  onCommit,
}: SourceControlSidebarProps) {
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const groups = useMemo(() => {
    const visible = (status?.files ?? []).filter((file) => {
      if (file.ignored) return false;
      return normalizedQuery.length === 0 || file.path.toLocaleLowerCase().includes(normalizedQuery);
    });
    return {
      conflicts: visible.filter((file) => file.conflict),
      staged: visible.filter((file) => file.staged && !file.conflict),
      changes: visible.filter((file) => (file.modified || file.untracked) && !file.conflict),
    };
  }, [normalizedQuery, status]);

  const submitCommit = async () => {
    const commitMessage = message.trim();
    if (!commitMessage || busy) return;
    const result = await onCommit(commitMessage);
    if (result !== null) setMessage("");
  };

  return (
    <aside className="sidebar panel-surface git-sidebar git-source-sidebar" aria-label="Source control" aria-busy={loading || busy}>
      <label className="search-field git-filter-field">
        <Filter aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter changes"
          aria-label="Filter changed files"
        />
        <button
          type="button"
          className="sidebar-menu-trigger"
          aria-label="Refresh source control"
          title="Refresh source control"
          disabled={loading}
          onClick={() => void onRefresh()}
        >
          <RefreshCw className={loading ? "git-spin" : ""} aria-hidden="true" />
        </button>
      </label>

      <div className="git-repository-row">
        <GitBranch aria-hidden="true" />
        <div>
          <strong>{repositoryName}</strong>
          <span>{status ? branchLabel(status) : "Source Control"}</span>
        </div>
        {status && (status.branch.ahead > 0 || status.branch.behind > 0) ? (
          <small aria-label={`${status.branch.ahead} ahead, ${status.branch.behind} behind`}>
            {status.branch.ahead > 0 ? `↑${status.branch.ahead}` : ""}
            {status.branch.ahead > 0 && status.branch.behind > 0 ? " " : ""}
            {status.branch.behind > 0 ? `↓${status.branch.behind}` : ""}
          </small>
        ) : null}
      </div>

      <div className="git-sidebar-scroll">
        <AnimatePresence initial={false} mode="popLayout">
        {error ? (
          <motion.div
            className="git-inline-message git-inline-message--error"
            role="status"
            key="source-error"
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={revealTransition}
          >
            <AlertTriangle aria-hidden="true" />
            <span>{error}</span>
          </motion.div>
        ) : null}
        </AnimatePresence>

        {notRepository ? (
          <div className="git-empty-state">
            <GitBranch aria-hidden="true" />
            <strong>No Git repository</strong>
            <p>Open a folder whose root contains a Git repository.</p>
            <button type="button" disabled={loading} onClick={() => void onRefresh()}>Check again</button>
          </div>
        ) : null}

        <AnimatePresence initial={false} mode="wait">
        {!notRepository && loading && !status ? (
          <motion.div
            className="git-loading-state"
            role="status"
            key="source-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={revealTransition}
          >
            <LoaderCircle className="git-spin" aria-hidden="true" />
            <span>Reading working tree…</span>
          </motion.div>
        ) : null}
        </AnimatePresence>

        {!notRepository && status ? (
          <>
            <form className="git-commit-box" onSubmit={(event) => { event.preventDefault(); void submitCommit(); }}>
              <label htmlFor="git-commit-message">Commit message</label>
              <textarea
                id="git-commit-message"
                value={message}
                rows={3}
                maxLength={65_536}
                placeholder="Message (⌘Enter to commit)"
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && event.metaKey) {
                    event.preventDefault();
                    void submitCommit();
                  }
                }}
              />
              <button
                type="submit"
                disabled={busy || message.trim().length === 0 || status.counts.staged === 0}
                aria-label={busy ? "Committing changes" : "Commit staged changes"}
              >
                <AnimatePresence initial={false} mode="wait">
                  <motion.span
                    className="git-operation-icon"
                    key={busy ? "busy" : "ready"}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={revealTransition}
                  >
                    {busy ? <LoaderCircle className="git-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
                  </motion.span>
                </AnimatePresence>
                Commit
              </button>
            </form>

            <ChangeSection
              title="Conflicts"
              files={groups.conflicts}
              mode="working"
              emptyLabel="No unresolved conflicts"
              action="stage"
              busy={busy}
              onOpenFile={onOpenFile}
              onOpenPatch={onOpenPatch}
              onAction={onStage}
            />
            <ChangeSection
              title="Staged Changes"
              files={groups.staged}
              mode="staged"
              emptyLabel="Nothing staged"
              action="unstage"
              busy={busy}
              onOpenFile={onOpenFile}
              onOpenPatch={onOpenPatch}
              onAction={onUnstage}
            />
            <ChangeSection
              title="Changes"
              files={groups.changes}
              mode="working"
              emptyLabel={normalizedQuery ? "No matching changes" : "Working tree is clean"}
              action="stage"
              busy={busy}
              onOpenFile={onOpenFile}
              onOpenPatch={onOpenPatch}
              onAction={onStage}
            />
          </>
        ) : null}
      </div>
      <div className="sidebar-scrollbar" aria-hidden="true"><span /></div>
    </aside>
  );
}
