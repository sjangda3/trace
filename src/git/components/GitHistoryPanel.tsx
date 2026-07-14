import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import type { GitBranches, GitCommit, GitLog } from "../types";

const revealTransition = { type: "tween" as const, duration: 0.14 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.16,
  layout: { type: "tween" as const, duration: 0.16 },
};

export interface GitHistoryPanelProps {
  repositoryName: string;
  history: GitLog | null;
  branches?: GitBranches | null;
  loading?: boolean;
  notRepository?: boolean;
  error?: string | null;
  selectedHash?: string | null;
  onClose: () => void;
  onRefresh?: () => void | GitLog | null | Promise<GitLog | null>;
  onSelectCommit?: (commit: GitCommit) => void;
  onLoadMore?: () => void | GitLog | null | Promise<GitLog | null>;
}

function relativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const difference = date.getTime() - Date.now();
  const absolute = Math.abs(difference);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60 * 1_000],
    ["month", 30 * 24 * 60 * 60 * 1_000],
    ["day", 24 * 60 * 60 * 1_000],
    ["hour", 60 * 60 * 1_000],
    ["minute", 60 * 1_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, milliseconds] of units) {
    if (absolute >= milliseconds || unit === "minute") {
      return formatter.format(Math.round(difference / milliseconds), unit);
    }
  }
  return date.toLocaleDateString();
}

function CommitLane({ commit, first, last }: { commit: GitCommit; first: boolean; last: boolean }) {
  const root = commit.parents.length === 0;
  const merge = commit.parents.length > 1;
  return (
    <svg className="git-commit-lane" viewBox="0 0 38 48" aria-hidden="true">
      {!first ? <path d="M11 0 V19" /> : null}
      {!last && !root ? <path d="M11 29 V48" /> : null}
      {merge ? <path className="git-lane-secondary" d="M11 24 C26 24 27 33 27 48" /> : null}
      <circle cx="11" cy="24" r="4" />
      {merge ? <circle className="git-lane-secondary-dot" cx="27" cy="40" r="2" /> : null}
    </svg>
  );
}

function HistoryEmpty({ notRepository }: { notRepository: boolean }) {
  return (
    <div className="git-history-empty">
      <GitCommitHorizontal aria-hidden="true" />
      <strong>{notRepository ? "No Git history" : "No commits yet"}</strong>
      <p>{notRepository ? "Open a Git repository to inspect its commit history." : "The first commit will appear here."}</p>
    </div>
  );
}

export function GitHistoryPanel({
  repositoryName,
  history,
  branches = null,
  loading = false,
  notRepository = false,
  error = null,
  selectedHash = null,
  onClose,
  onRefresh,
  onSelectCommit,
  onLoadMore,
}: GitHistoryPanelProps) {
  const refsByHash = useMemo(() => {
    const refs = new Map<string, string[]>();
    for (const branch of [...(branches?.local ?? []), ...(branches?.remote ?? [])]) {
      const current = refs.get(branch.hash) ?? [];
      current.push(branch.name);
      refs.set(branch.hash, current);
    }
    return refs;
  }, [branches]);

  const commits = history?.commits ?? [];
  const currentLabel = branches?.detached ? "Detached HEAD" : branches?.current ?? repositoryName;

  return (
    <motion.section
      className="project-map-panel git-history-panel"
      aria-label="Git history"
      aria-busy={loading}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={revealTransition}
    >
      <header>
        <div>
          <span className="eyebrow">Git History</span>
          <strong>{currentLabel}</strong>
        </div>
        <div className="git-history-header-actions">
          {onRefresh ? (
            <button type="button" aria-label="Refresh Git history" title="Refresh" disabled={loading} onClick={() => void onRefresh()}>
              <RefreshCw className={loading ? "git-spin" : ""} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label="Close Git history" title="Close" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>

      <div className="git-history-body">
        <AnimatePresence initial={false} mode="popLayout">
        {error ? (
          <motion.div
            className="git-inline-message git-inline-message--error"
            role="status"
            key="history-error"
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

        <AnimatePresence initial={false} mode="wait">
        {loading && !history ? (
          <motion.div
            className="git-loading-state"
            role="status"
            key="history-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={revealTransition}
          >
            <LoaderCircle className="git-spin" aria-hidden="true" />
            <span>Reading commit history…</span>
          </motion.div>
        ) : null}
        </AnimatePresence>

        {!loading && (notRepository || commits.length === 0) ? <HistoryEmpty notRepository={notRepository} /> : null}

        {commits.length > 0 ? (
          <ol className="git-commit-list" aria-label="Commits">
            <AnimatePresence initial={false} mode="popLayout">
            {commits.map((commit, index) => {
              const refs = refsByHash.get(commit.hash) ?? [];
              const selected = selectedHash === commit.hash;
              return (
                <motion.li
                  key={commit.hash}
                  layout="position"
                  initial={{ opacity: 0, y: 3 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -3 }}
                  transition={layoutTransition}
                >
                  <CommitLane commit={commit} first={index === 0} last={index === commits.length - 1 && !history?.hasMore} />
                  <button
                    type="button"
                    className={`git-commit-row ${selected ? "is-selected" : ""}`}
                    aria-pressed={selected}
                    title={`${commit.hash}\n${commit.author.name} <${commit.author.email}>`}
                    onClick={() => onSelectCommit?.(commit)}
                  >
                    {selected ? <motion.span className="git-selection-indicator" layoutId="git-selected-commit" transition={revealTransition} /> : null}
                    <span className="git-commit-subject">{commit.subject || "Untitled commit"}</span>
                    {refs.length > 0 ? (
                      <span className="git-commit-refs">
                        {refs.slice(0, 2).map((ref) => (
                          <span key={ref}><GitBranch aria-hidden="true" />{ref}</span>
                        ))}
                        {refs.length > 2 ? <small>+{refs.length - 2}</small> : null}
                      </span>
                    ) : null}
                    <span className="git-commit-meta">
                      <span>{commit.author.name}</span>
                      <time dateTime={commit.date} title={new Date(commit.date).toLocaleString()}>{relativeDate(commit.date)}</time>
                    </span>
                    <code>{commit.hash.slice(0, 7)}</code>
                  </button>
                </motion.li>
              );
            })}
            </AnimatePresence>
          </ol>
        ) : null}

        {history?.hasMore && onLoadMore ? (
          <button type="button" className="git-load-more" disabled={loading} onClick={() => void onLoadMore()}>
            {loading ? <LoaderCircle className="git-spin" aria-hidden="true" /> : null}
            Load older commits
          </button>
        ) : null}
      </div>
    </motion.section>
  );
}
