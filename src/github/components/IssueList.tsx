import { useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, CircleDot, LoaderCircle, MessageSquare } from "lucide-react";
import type { GitHubIssueSummary } from "../types";
import { identityInitials } from "./PullRequestList";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export interface IssueListProps {
  items: GitHubIssueSummary[];
  selectedNumber?: number | null;
  loading?: boolean;
  query?: string;
  onSelect: (issue: GitHubIssueSummary) => void;
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

function IssueSection({
  title,
  items,
  selectedNumber,
  onSelect,
}: {
  title: string;
  items: GitHubIssueSummary[];
  selectedNumber: number | null;
  onSelect: IssueListProps["onSelect"];
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
          key="issue-items"
          initial={{ opacity: 0, scaleY: 0.98 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.98 }}
          style={{ transformOrigin: "top" }}
          transition={revealTransition}
        >
          <AnimatePresence initial={false} mode="popLayout">
          {items.map((issue) => {
            const selected = selectedNumber === issue.number;
            return (
              <motion.button
                type="button"
                className={`github-item-row github-issue-row ${selected ? "is-selected" : ""}`}
                aria-pressed={selected}
                key={issue.id}
                layout="position"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={layoutTransition}
                onClick={() => onSelect(issue)}
              >
                {selected ? <motion.span className="github-selection-indicator" layoutId="github-selected-issue" transition={revealTransition} /> : null}
                {issue.state === "closed" ? (
                  <Check className="github-state-icon is-closed-issue" aria-label="Closed issue" />
                ) : (
                  <CircleDot className="github-state-icon is-open-issue" aria-label="Open issue" />
                )}
                <span className="github-item-copy">
                  <strong>{issue.title}</strong>
                  <span>
                    #{issue.number} · {issue.author?.login ?? "ghost"} · {relativeDate(issue.updatedAt)}
                  </span>
                  {issue.labels.length > 0 ? (
                    <span className="github-row-labels">
                      {issue.labels.slice(0, 2).map((label) => <small key={label.id}>{label.name}</small>)}
                    </span>
                  ) : null}
                </span>
                <span className="github-item-aside">
                  <span className="github-initial-avatar" aria-label={issue.author?.login ?? "Unknown author"}>
                    {identityInitials(issue.author)}
                  </span>
                  {issue.commentCount > 0 ? (
                    <span className="github-row-signals" aria-label={`${issue.commentCount} comments`}>
                      <span><MessageSquare aria-hidden="true" />{issue.commentCount}</span>
                    </span>
                  ) : null}
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

export function IssueList({
  items,
  selectedNumber = null,
  loading = false,
  query = "",
  onSelect,
}: IssueListProps) {
  if (loading && items.length === 0) {
    return (
      <motion.div className="github-list-loading" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={revealTransition}>
        <LoaderCircle className="git-spin" aria-hidden="true" />
        <span>Loading issues…</span>
      </motion.div>
    );
  }

  if (items.length === 0) {
    return (
      <motion.div className="github-compact-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={revealTransition}>
        <CircleDot aria-hidden="true" />
        <strong>{query.trim() ? "No matching issues" : "No issues"}</strong>
        <p>{query.trim() ? "Try a different search." : "Repository issues will appear here."}</p>
      </motion.div>
    );
  }

  const assigned = items.filter((issue) => issue.assignedToViewer);
  const repository = items.filter((issue) => !issue.assignedToViewer);

  return (
    <div className="github-list" aria-label="Issues">
      <IssueSection title="Assigned to you" items={assigned} selectedNumber={selectedNumber} onSelect={onSelect} />
      <IssueSection title="Repository" items={repository} selectedNumber={selectedNumber} onSelect={onSelect} />
    </div>
  );
}
