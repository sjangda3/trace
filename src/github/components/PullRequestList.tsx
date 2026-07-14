import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronDown,
  CircleDot,
  GitMerge,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  X,
} from "lucide-react";
import type { GitHubIdentity, GitHubPullRequestSummary } from "../types";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export interface PullRequestListProps {
  items: GitHubPullRequestSummary[];
  selectedNumber?: number | null;
  loading?: boolean;
  query?: string;
  onSelect: (pullRequest: GitHubPullRequestSummary) => void;
}

function relativeDate(value: string | null): string {
  if (!value) return "recently";
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

export function identityInitials(identity: GitHubIdentity | null): string {
  if (!identity) return "?";
  const value = identity.name?.trim() || identity.login.trim() || "?";
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length > 1) return `${words[0][0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toLocaleUpperCase();
  return value.slice(0, 2).toLocaleUpperCase();
}

function PullRequestIcon({ pullRequest }: { pullRequest: GitHubPullRequestSummary }) {
  if (pullRequest.state === "merged") return <GitMerge className="github-state-icon is-merged" aria-hidden="true" />;
  if (pullRequest.state === "closed") return <X className="github-state-icon is-closed" aria-hidden="true" />;
  if (pullRequest.draft) return <CircleDot className="github-state-icon is-draft" aria-hidden="true" />;
  return <GitPullRequest className="github-state-icon is-open" aria-hidden="true" />;
}

function ReviewMark({ pullRequest }: { pullRequest: GitHubPullRequestSummary }) {
  if (pullRequest.reviewDecision === "approved") {
    return <Check className="github-review-mark is-approved" aria-label="Approved" />;
  }
  if (pullRequest.reviewDecision === "changes-requested") {
    return <X className="github-review-mark is-changes-requested" aria-label="Changes requested" />;
  }
  return null;
}

function PullRequestSection({
  title,
  items,
  selectedNumber,
  onSelect,
}: {
  title: string;
  items: GitHubPullRequestSummary[];
  selectedNumber: number | null;
  onSelect: PullRequestListProps["onSelect"];
}) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();
  if (items.length === 0) return null;

  return (
    <motion.section className="github-list-section" layout transition={layoutTransition}>
      <button
        type="button"
        className="git-section-toggle github-section-toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronDown aria-hidden="true" />
        <span>{title}</span>
        <small>{items.length}</small>
      </button>
      <AnimatePresence initial={false} mode="popLayout">
      {expanded ? (
        <motion.div
          className="github-item-list"
          id={listId}
          key="pull-request-items"
          initial={{ opacity: 0, scaleY: 0.98 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.98 }}
          style={{ transformOrigin: "top" }}
          transition={revealTransition}
        >
          <AnimatePresence initial={false} mode="popLayout">
          {items.map((pullRequest) => {
            const selected = selectedNumber === pullRequest.number;
            return (
              <motion.button
                type="button"
                className={`github-item-row github-pr-row ${selected ? "is-selected" : ""}`}
                aria-pressed={selected}
                key={pullRequest.id}
                layout="position"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={layoutTransition}
                onClick={() => onSelect(pullRequest)}
              >
                {selected ? <motion.span className="github-selection-indicator" layoutId="github-selected-pull-request" transition={revealTransition} /> : null}
                <PullRequestIcon pullRequest={pullRequest} />
                <span className="github-item-copy">
                  <strong>{pullRequest.title}</strong>
                  <span>
                    #{pullRequest.number} · {pullRequest.author?.login ?? "ghost"} · {relativeDate(pullRequest.updatedAt)}
                  </span>
                </span>
                <span className="github-item-aside">
                  <span className="github-initial-avatar" aria-label={pullRequest.author?.login ?? "Unknown author"}>
                    {identityInitials(pullRequest.author)}
                  </span>
                  <span className="github-row-signals">
                    <ReviewMark pullRequest={pullRequest} />
                    {pullRequest.commentCount > 0 ? (
                      <span aria-label={`${pullRequest.commentCount} comments`}><MessageSquare aria-hidden="true" />{pullRequest.commentCount}</span>
                    ) : null}
                  </span>
                </span>
              </motion.button>
            );
          })}
          </AnimatePresence>
        </motion.div>
      ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

export function PullRequestList({
  items,
  selectedNumber = null,
  loading = false,
  query = "",
  onSelect,
}: PullRequestListProps) {
  if (loading && items.length === 0) {
    return (
      <motion.div className="github-list-loading" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={revealTransition}>
        <LoaderCircle className="git-spin" aria-hidden="true" />
        <span>Loading pull requests…</span>
      </motion.div>
    );
  }

  if (items.length === 0) {
    return (
      <motion.div className="github-compact-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={revealTransition}>
        <GitPullRequest aria-hidden="true" />
        <strong>{query.trim() ? "No matching pull requests" : "No pull requests"}</strong>
        <p>{query.trim() ? "Try a different search." : "Open pull requests will appear here."}</p>
      </motion.div>
    );
  }

  const requested = items.filter((pullRequest) => pullRequest.reviewRequested);
  const repository = items.filter((pullRequest) => !pullRequest.reviewRequested);

  return (
    <div className="github-list" aria-label="Pull requests">
      <PullRequestSection title="Review requested" items={requested} selectedNumber={selectedNumber} onSelect={onSelect} />
      <PullRequestSection title="Repository" items={repository} selectedNumber={selectedNumber} onSelect={onSelect} />
    </div>
  );
}
