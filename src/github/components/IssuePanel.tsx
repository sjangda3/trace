import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  CircleDot,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  X,
} from "lucide-react";
import type { GitHubIssueDetail } from "../types";
import { identityInitials } from "./PullRequestList";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export interface IssuePanelProps {
  issue: GitHubIssueDetail | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onRetry?: () => void | Promise<GitHubIssueDetail | null>;
  onOpenExternal?: (url: string) => void;
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

export function IssuePanel({
  issue,
  loading = false,
  error = null,
  onClose,
  onRetry,
  onOpenExternal,
}: IssuePanelProps) {
  const [view, setView] = useState<"overview" | "activity">("overview");
  useEffect(() => setView("overview"), [issue?.number]);

  return (
    <motion.section
      className="project-map-panel github-detail-panel github-issue-panel"
      aria-label={issue ? `Issue ${issue.number}` : "Issue"}
      aria-busy={loading}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={revealTransition}
    >
      <header>
        <div>
          <span className="eyebrow">Issue{issue ? ` #${issue.number}` : ""}</span>
          <strong>{issue?.title ?? "Issue"}</strong>
        </div>
        <div className="github-detail-header-actions">
          {onRetry ? (
            <button type="button" aria-label="Refresh issue" title="Refresh" disabled={loading} onClick={() => void onRetry()}>
              <RefreshCw className={loading ? "git-spin" : ""} aria-hidden="true" />
            </button>
          ) : null}
          <button type="button" aria-label="Open issue on GitHub" title="Open on GitHub" disabled={!issue} onClick={() => issue && openExternal(issue.url, onOpenExternal)}>
            <ExternalLink aria-hidden="true" />
          </button>
          <button type="button" aria-label="Close issue" title="Close" onClick={onClose}><X aria-hidden="true" /></button>
        </div>
      </header>

      <AnimatePresence initial={false} mode="popLayout">
      {issue ? (
        <motion.div className="github-detail-summary" key={`issue-summary-${issue.number}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
          <span className={`github-issue-state is-${issue.state}`}>
            {issue.state === "open" ? <CircleDot aria-hidden="true" /> : <Check aria-hidden="true" />}{issue.state}
          </span>
          <span>{issue.author?.login ?? "ghost"}</span>
          <span>{dateLabel(issue.createdAt)}</span>
        </motion.div>
      ) : null}
      </AnimatePresence>

      <div className="github-detail-tabs" role="tablist" aria-label="Issue details">
        <button type="button" role="tab" aria-selected={view === "overview"} aria-controls="github-issue-tabpanel" id="github-issue-tab-overview" className={view === "overview" ? "is-active" : ""} onClick={() => setView("overview")}>
          Overview
          {view === "overview" ? <motion.span className="github-tab-indicator" layoutId="github-issue-tab-indicator" transition={revealTransition} /> : null}
        </button>
        <button type="button" role="tab" aria-selected={view === "activity"} aria-controls="github-issue-tabpanel" id="github-issue-tab-activity" className={view === "activity" ? "is-active" : ""} onClick={() => setView("activity")}>
          Activity<small>{issue?.comments.length ?? 0}</small>
          {view === "activity" ? <motion.span className="github-tab-indicator" layoutId="github-issue-tab-indicator" transition={revealTransition} /> : null}
        </button>
      </div>

      <div className="github-detail-scroll" id="github-issue-tabpanel" role="tabpanel" aria-labelledby={`github-issue-tab-${view}`}>
        <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.div className="github-panel-message github-panel-message--error" role="status" key="issue-error" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={revealTransition}>
            <AlertTriangle aria-hidden="true" />
            <strong>Couldn’t load this issue</strong>
            <span>{error}</span>
            {onRetry ? <button type="button" onClick={() => void onRetry()}>Try Again</button> : null}
          </motion.div>
        ) : null}
        {!error && loading && !issue ? (
          <motion.div className="github-panel-message" role="status" key="issue-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}><LoaderCircle className="git-spin" aria-hidden="true" /><span>Loading issue…</span></motion.div>
        ) : null}
        {!error && !loading && !issue ? (
          <motion.div className="github-panel-message" key="issue-unavailable" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}><CircleDot aria-hidden="true" /><strong>Issue unavailable</strong></motion.div>
        ) : null}
        {!error && issue && view === "overview" ? (
          <motion.div className="github-detail-overview" key="issue-overview" initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={revealTransition}>
            <div className="github-author-line">
              <span className="github-initial-avatar">{identityInitials(issue.author)}</span>
              <span><strong>{issue.author?.login ?? "ghost"}</strong> opened this issue {dateLabel(issue.createdAt)}</span>
            </div>
            <div className="github-detail-body-copy">{issue.body.trim() ? issue.body : "No description provided."}</div>
            {issue.labels.length > 0 ? (
              <section className="github-detail-section">
                <header><strong>Labels</strong><small>{issue.labels.length}</small></header>
                <div className="github-label-list">{issue.labels.map((label) => <span key={label.id}>{label.name}</span>)}</div>
              </section>
            ) : null}
            <section className="github-detail-section">
              <header><strong>Assignees</strong><small>{issue.assignees.length}</small></header>
              {issue.assignees.length === 0 ? <p>No one assigned.</p> : (
                <div className="github-reviewer-list">
                  {issue.assignees.map((assignee) => <span key={assignee.login}><span className="github-initial-avatar">{identityInitials(assignee)}</span>{assignee.login}</span>)}
                </div>
              )}
            </section>
          </motion.div>
        ) : null}
        {!error && issue && view === "activity" ? (
          issue.comments.length === 0 ? (
            <motion.div className="github-detail-empty" key="issue-comments-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}><MessageSquare aria-hidden="true" /><strong>No comments yet</strong></motion.div>
          ) : (
            <motion.div className="github-issue-comments" key="issue-comments" initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={revealTransition}>
              <AnimatePresence initial={false} mode="popLayout">
              {issue.comments.map((comment) => (
                <motion.article key={comment.id} layout="position" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={layoutTransition}>
                  <header>
                    <span className="github-initial-avatar">{identityInitials(comment.author)}</span>
                    <strong>{comment.author?.login ?? "ghost"}</strong>
                    <time dateTime={comment.createdAt ?? undefined}>{dateLabel(comment.createdAt)}</time>
                  </header>
                  <p>{comment.body}</p>
                </motion.article>
              ))}
              </AnimatePresence>
            </motion.div>
          )
        ) : null}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
