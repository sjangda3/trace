import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleDot,
  CircleX,
  ExternalLink,
  FileDiff,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  GitHubPullRequestDetail,
  GitHubPullRequestFile,
  GitHubReviewAnchor,
  GitHubReviewThread,
} from "../types";
import { identityInitials } from "./PullRequestList";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export type PullRequestPanelView = "overview" | "review" | "files";

export interface PullRequestPanelProps {
  pullRequest: GitHubPullRequestDetail | null;
  loading?: boolean;
  error?: string | null;
  selectedThreadId?: string | null;
  onClose: () => void;
  onRetry?: () => void | Promise<GitHubPullRequestDetail | null>;
  onOpenExternal?: (url: string) => void;
  onSelectThread?: (thread: GitHubReviewThread) => void;
  onSelectReviewAnchor: (anchor: GitHubReviewAnchor) => void;
  onSelectFile?: (file: GitHubPullRequestFile) => void;
}

function openExternal(url: string, callback?: (url: string) => void) {
  if (callback) {
    callback(url);
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") window.open(parsed.toString(), "_blank", "noopener,noreferrer");
  } catch {
    // Invalid URLs are ignored.
  }
}

function dateLabel(value: string | null): string {
  if (!value) return "recently";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StateIcon({ pullRequest }: { pullRequest: GitHubPullRequestDetail }) {
  if (pullRequest.state === "merged") return <GitMerge className="is-merged" aria-hidden="true" />;
  if (pullRequest.state === "closed") return <CircleX className="is-closed" aria-hidden="true" />;
  return <GitPullRequest className="is-open" aria-hidden="true" />;
}

function Overview({ pullRequest }: { pullRequest: GitHubPullRequestDetail }) {
  const completedChecks = pullRequest.checks.filter((check) => check.status === "success").length;
  return (
    <motion.div className="github-detail-overview" initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={revealTransition}>
      <div className="github-author-line">
        <span className="github-initial-avatar">{identityInitials(pullRequest.author)}</span>
        <span><strong>{pullRequest.author?.login ?? "ghost"}</strong> opened this pull request {dateLabel(pullRequest.createdAt)}</span>
      </div>

      <div className="github-branch-route">
        <GitBranch aria-hidden="true" />
        <code>{pullRequest.headRefName}</code>
        <ChevronRight aria-hidden="true" />
        <code>{pullRequest.baseRefName}</code>
      </div>

      <div className="github-detail-body-copy">
        {pullRequest.body.trim() ? pullRequest.body : "No description provided."}
      </div>

      <div className="github-detail-stats" aria-label="Pull request statistics">
        <span><strong>{pullRequest.changedFiles}</strong> files</span>
        <span className="is-addition">+{pullRequest.additions}</span>
        <span className="is-deletion">−{pullRequest.deletions}</span>
        <span>{pullRequest.commentCount} comments</span>
      </div>

      <section className="github-detail-section">
        <header><strong>Checks</strong><small>{pullRequest.checks.length ? `${completedChecks}/${pullRequest.checks.length}` : "None"}</small></header>
        {pullRequest.checks.length === 0 ? <p>No checks reported.</p> : (
          <div className="github-check-list">
            {pullRequest.checks.slice(0, 6).map((check) => (
              <div key={check.id} className={`github-check-row is-${check.status}`}>
                {check.status === "success" ? <Check aria-hidden="true" /> : check.status === "failure" ? <X aria-hidden="true" /> : <CircleDot aria-hidden="true" />}
                <span>{check.name}</span>
                <small>{check.status.replace("-", " ")}</small>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="github-detail-section">
        <header><strong>Reviewers</strong><small>{pullRequest.reviewers.length}</small></header>
        {pullRequest.reviewers.length === 0 ? <p>No reviewers assigned.</p> : (
          <div className="github-reviewer-list">
            {pullRequest.reviewers.map((reviewer) => (
              <span key={reviewer.login}><span className="github-initial-avatar">{identityInitials(reviewer)}</span>{reviewer.login}</span>
            ))}
          </div>
        )}
      </section>
    </motion.div>
  );
}

function ReviewThreads({
  threads,
  selectedThreadId,
  onSelectThread,
  onSelectReviewAnchor,
}: {
  threads: GitHubReviewThread[];
  selectedThreadId: string | null;
  onSelectThread?: (thread: GitHubReviewThread) => void;
  onSelectReviewAnchor: (anchor: GitHubReviewAnchor) => void;
}) {
  const ordered = useMemo(() => [...threads].sort((left, right) => Number(left.resolved) - Number(right.resolved)), [threads]);
  if (ordered.length === 0) {
    return (
      <motion.div className="github-detail-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
        <MessageSquare aria-hidden="true" />
        <strong>No review feedback</strong>
        <p>Inline GitHub feedback will appear here.</p>
      </motion.div>
    );
  }

  return (
    <motion.div className="github-review-thread-list" initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={revealTransition}>
      <AnimatePresence initial={false} mode="popLayout">
      {ordered.map((thread) => {
        const comment = thread.comments.at(-1) ?? null;
        const selected = selectedThreadId === thread.id;
        return (
          <motion.button
            type="button"
            className={`github-review-thread ${selected ? "is-selected" : ""} ${thread.resolved ? "is-resolved" : ""}`}
            aria-pressed={selected}
            key={thread.id}
            layout="position"
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={layoutTransition}
            onClick={() => {
              onSelectThread?.(thread);
              onSelectReviewAnchor(thread.anchor);
            }}
          >
            {selected ? <motion.span className="github-selection-indicator" layoutId="github-selected-review-thread" transition={revealTransition} /> : null}
            <span className="github-review-thread-heading">
              <FileDiff aria-hidden="true" />
              <strong>{thread.anchor.path}</strong>
              <small>
                {thread.anchor.outdated ? "Outdated" : `Line ${thread.anchor.startLine}${thread.anchor.endLine !== thread.anchor.startLine ? `–${thread.anchor.endLine}` : ""}`}
              </small>
            </span>
            <span className="github-review-comment-preview">
              <span className="github-initial-avatar">{identityInitials(comment?.author ?? null)}</span>
              <span>
                <strong>{comment?.author?.login ?? "ghost"}</strong>
                <span>{comment?.body.trim() || "Review feedback"}</span>
              </span>
            </span>
            <span className="github-review-thread-meta">
              {thread.resolved ? <span><Check aria-hidden="true" />Resolved</span> : <span>Open</span>}
              {thread.comments.length > 1 ? <span>{thread.comments.length} replies</span> : null}
            </span>
          </motion.button>
        );
      })}
      </AnimatePresence>
    </motion.div>
  );
}

function Files({
  files,
  onSelectFile,
}: {
  files: GitHubPullRequestFile[];
  onSelectFile?: (file: GitHubPullRequestFile) => void;
}) {
  if (files.length === 0) {
    return (
      <motion.div className="github-detail-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
        <FileDiff aria-hidden="true" />
        <strong>No changed files</strong>
      </motion.div>
    );
  }
  return (
    <motion.div className="github-file-list" initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={revealTransition}>
      {files.map((file) => {
        const content = (
          <>
            <FileDiff aria-hidden="true" />
            <span><strong>{file.path}</strong>{file.previousPath ? <small>from {file.previousPath}</small> : null}</span>
            <span className="github-file-stats"><small>+{file.additions}</small><small>−{file.deletions}</small></span>
          </>
        );
        return onSelectFile ? (
          <button type="button" className="github-file-row" key={file.path} onClick={() => onSelectFile(file)}>{content}</button>
        ) : (
          <div className="github-file-row" key={file.path}>{content}</div>
        );
      })}
    </motion.div>
  );
}

export function PullRequestPanel({
  pullRequest,
  loading = false,
  error = null,
  selectedThreadId = null,
  onClose,
  onRetry,
  onOpenExternal,
  onSelectThread,
  onSelectReviewAnchor,
  onSelectFile,
}: PullRequestPanelProps) {
  const [view, setView] = useState<PullRequestPanelView>("overview");

  useEffect(() => setView("overview"), [pullRequest?.number]);

  return (
    <motion.section
      className="project-map-panel github-detail-panel github-pull-request-panel"
      aria-label={pullRequest ? `Pull request ${pullRequest.number}` : "Pull request"}
      aria-busy={loading}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={revealTransition}
    >
      <header>
        <div>
          <span className="eyebrow">Pull Request{pullRequest ? ` #${pullRequest.number}` : ""}</span>
          <strong>{pullRequest?.title ?? "Pull request"}</strong>
        </div>
        <div className="github-detail-header-actions">
          {onRetry ? (
            <button type="button" aria-label="Refresh pull request" title="Refresh" disabled={loading} onClick={() => void onRetry()}>
              <RefreshCw className={loading ? "git-spin" : ""} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label="Open pull request on GitHub" title="Open on GitHub" disabled={!pullRequest} onClick={() => pullRequest && openExternal(pullRequest.url, onOpenExternal)}>
            <ExternalLink aria-hidden="true" />
          </button>
          <button type="button" aria-label="Close pull request" title="Close" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>

      <AnimatePresence initial={false} mode="popLayout">
      {pullRequest ? (
        <motion.div className="github-detail-summary" key={`summary-${pullRequest.number}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
          <span className={`github-pr-state is-${pullRequest.state}`}><StateIcon pullRequest={pullRequest} />{pullRequest.draft ? "Draft" : pullRequest.state}</span>
          <span>{pullRequest.author?.login ?? "ghost"}</span>
          <code>{pullRequest.headRefName}</code>
          <ChevronRight aria-hidden="true" />
          <code>{pullRequest.baseRefName}</code>
        </motion.div>
      ) : null}
      </AnimatePresence>

      <div className="github-detail-tabs" role="tablist" aria-label="Pull request details">
        {([
          ["overview", "Overview", null],
          ["review", "Review", pullRequest?.reviewThreads.length ?? null],
          ["files", "Files", pullRequest?.files.length ?? null],
        ] as const).map(([id, label, count]) => (
          <button
            type="button"
            role="tab"
            aria-selected={view === id}
            aria-controls="github-pull-request-tabpanel"
            id={`github-pull-request-tab-${id}`}
            className={view === id ? "is-active" : ""}
            key={id}
            onClick={() => setView(id)}
          >
            {label}{count !== null ? <small>{count}</small> : null}
            {view === id ? <motion.span className="github-tab-indicator" layoutId="github-pull-request-tab-indicator" transition={revealTransition} /> : null}
          </button>
        ))}
      </div>

      <div className="github-detail-scroll" id="github-pull-request-tabpanel" role="tabpanel" aria-labelledby={`github-pull-request-tab-${view}`}>
        <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.div className="github-panel-message github-panel-message--error" role="status" key="pull-request-error" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={revealTransition}>
            <AlertTriangle aria-hidden="true" />
            <strong>Couldn’t load this pull request</strong>
            <span>{error}</span>
            {onRetry ? <button type="button" onClick={() => void onRetry()}>Try Again</button> : null}
          </motion.div>
        ) : null}
        {!error && loading && !pullRequest ? (
          <motion.div className="github-panel-message" role="status" key="pull-request-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}><LoaderCircle className="git-spin" aria-hidden="true" /><span>Loading pull request…</span></motion.div>
        ) : null}
        {!error && !loading && !pullRequest ? (
          <motion.div className="github-panel-message" key="pull-request-unavailable" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}><GitPullRequest aria-hidden="true" /><strong>Pull request unavailable</strong></motion.div>
        ) : null}
        {!error && pullRequest && view === "overview" ? <Overview key="overview" pullRequest={pullRequest} /> : null}
        {!error && pullRequest && view === "review" ? (
          <ReviewThreads
            key="review"
            threads={pullRequest.reviewThreads}
            selectedThreadId={selectedThreadId}
            onSelectThread={onSelectThread}
            onSelectReviewAnchor={onSelectReviewAnchor}
          />
        ) : null}
        {!error && pullRequest && view === "files" ? <Files key="files" files={pullRequest.files} onSelectFile={onSelectFile} /> : null}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
