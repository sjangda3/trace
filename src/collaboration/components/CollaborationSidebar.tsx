import { useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronDown,
  Crosshair,
  Filter,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  UserPlus,
  UsersRound,
} from "lucide-react";
import type { CollaborationWorkspaceController } from "../useCollaborationWorkspace";
import type { CodeAnnotation } from "../types";
import {
  CollaborationSyncIndicator,
  MemberAvatar,
  MemberPresenceRow,
  MemberPresenceStrip,
} from "./MemberPresence";
import { WriterControlStatus } from "./WriterControlStatus";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export interface CollaborationSidebarProps {
  workspaceName: string;
  collaboration: CollaborationWorkspaceController;
  activePath?: string | null;
  selectedAnnotationId?: string | null;
  onSelectAnnotation: (annotation: CodeAnnotation) => void;
  onFocusAnnotation?: (annotation: CodeAnnotation) => void;
  onStartAnnotation?: () => void;
  onInviteMember?: () => void;
}

function lineLabel(annotation: CodeAnnotation) {
  const { startLine, endLine } = annotation.anchor;
  return startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
}

function relativeTime(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function annotationPreview(annotation: CodeAnnotation) {
  return annotation.messages[0]?.body.trim() || "Annotation";
}

function AnnotationRow({
  annotation,
  selected,
  onSelect,
  onFocus,
}: {
  annotation: CodeAnnotation;
  selected: boolean;
  onSelect: () => void;
  onFocus?: () => void;
}) {
  const author = annotation.messages[0]?.author ?? null;
  const pending = annotation.messages.some((message) => message.syncStatus !== "synced");
  return (
    <motion.div
      className={`collab-annotation-row ${selected ? "is-selected" : ""} ${annotation.status === "resolved" ? "is-resolved" : ""}`}
      layout="position"
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -3 }}
      transition={layoutTransition}
    >
      {selected ? <motion.span className="collab-selection-indicator" layoutId="collab-selected-annotation" transition={revealTransition} /> : null}
      <button type="button" className="collab-annotation-select" aria-pressed={selected} onClick={onSelect}>
        {author ? <MemberAvatar member={author} size="small" /> : <MessageSquareText aria-hidden="true" />}
        <span>
          <strong>{annotationPreview(annotation)}</strong>
          <small>
            <span>{annotation.anchor.path}</span>
            <span>{lineLabel(annotation)} · {relativeTime(annotation.updatedAt)}</span>
          </small>
        </span>
        <span className="collab-annotation-meta">
          {pending ? <i className="is-pending" title="Waiting to sync" /> : null}
          {annotation.messages.length > 1 ? <small>{annotation.messages.length}</small> : null}
        </span>
      </button>
      {onFocus ? (
        <button
          type="button"
          className="collab-row-action"
          aria-label={`Show ${annotation.anchor.path}, ${lineLabel(annotation)}`}
          title="Show in editor"
          onClick={onFocus}
        >
          <Crosshair aria-hidden="true" />
        </button>
      ) : null}
    </motion.div>
  );
}

export function CollaborationSidebar({
  workspaceName,
  collaboration,
  activePath = null,
  selectedAnnotationId = null,
  onSelectAnnotation,
  onFocusAnnotation,
  onStartAnnotation,
  onInviteMember,
}: CollaborationSidebarProps) {
  const [query, setQuery] = useState("");
  const [currentFileOnly, setCurrentFileOnly] = useState(false);
  const [peopleExpanded, setPeopleExpanded] = useState(true);
  const peopleBodyId = useId();
  const snapshot = collaboration.snapshot;
  const connection = snapshot?.connection ?? (collaboration.loading ? "connecting" : "unavailable");
  const offline = connection === "offline" || connection === "unavailable";
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const visibleAnnotations = useMemo(() => collaboration.annotations.filter((annotation) => {
    if (currentFileOnly && activePath && annotation.anchor.path !== activePath) return false;
    if (!normalizedQuery) return true;
    const content = [
      annotation.anchor.path,
      ...annotation.messages.flatMap((message) => [message.body, message.author.displayName, message.author.handle ?? ""]),
    ].join("\n").toLocaleLowerCase();
    return content.includes(normalizedQuery);
  }), [activePath, collaboration.annotations, currentFileOnly, normalizedQuery]);

  const open = visibleAnnotations.filter((annotation) => annotation.status === "open");
  const resolved = visibleAnnotations.filter((annotation) => annotation.status === "resolved");
  const activeMembers = collaboration.members.filter((member) => member.presence !== "offline");

  return (
    <aside className="sidebar panel-surface collab-sidebar" aria-label="Workspace collaboration" aria-busy={collaboration.loading}>
      <label className="search-field collab-search-field">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search annotations"
          aria-label="Search annotations"
        />
        <button
          type="button"
          className="sidebar-menu-trigger"
          disabled={collaboration.busy.has("snapshot")}
          aria-label="Refresh collaboration"
          title="Refresh collaboration"
          onClick={() => void collaboration.refresh()}
        >
          <RefreshCw className={collaboration.busy.has("snapshot") ? "collab-spin" : ""} aria-hidden="true" />
        </button>
      </label>

      <div className="collab-workspace-row">
        <UsersRound aria-hidden="true" />
        <div>
          <strong>{workspaceName}</strong>
          <span>{activeMembers.length} here · {collaboration.members.length} members</span>
        </div>
        <CollaborationSyncIndicator
          compact
          connection={connection}
          syncStatus={collaboration.syncStatus}
          pendingOperations={snapshot?.pendingOperations}
        />
      </div>

      <div className="collab-sidebar-scroll">
        <AnimatePresence initial={false} mode="popLayout">
        {collaboration.error ? (
          <motion.div className="collab-inline-message is-error" role="status" key="collab-error" initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={revealTransition}>
            <span>{collaboration.error.message}</span>
            <button type="button" onClick={collaboration.clearError}>Dismiss</button>
          </motion.div>
        ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false} mode="wait">
        {collaboration.loading && !snapshot ? (
          <motion.div className="collab-loading-state" role="status" key="collab-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <LoaderCircle className="collab-spin" aria-hidden="true" />
            <span>Joining workspace…</span>
          </motion.div>
        ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false} mode="wait">
        {snapshot?.connection === "unavailable" ? (
          <motion.div className="collab-unavailable-state" key="collab-unavailable" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <UsersRound aria-hidden="true" />
            <strong>Collaboration isn’t connected</strong>
            <p>{snapshot.message ?? "Connect this workspace to invite teammates and share annotations."}</p>
          </motion.div>
        ) : null}
        </AnimatePresence>

        {snapshot && snapshot.connection !== "unavailable" ? (
          <>
            <motion.section className="collab-people-section" layout transition={layoutTransition}>
              <div className="collab-section-heading">
                <button type="button" aria-expanded={peopleExpanded} aria-controls={peopleBodyId} onClick={() => setPeopleExpanded((value) => !value)}>
                  <ChevronDown aria-hidden="true" />
                  <span>People</span>
                  <small>{collaboration.members.length}</small>
                </button>
                {onInviteMember ? (
                  <button type="button" disabled={offline} aria-label="Invite workspace member" title="Invite member" onClick={onInviteMember}>
                    <UserPlus aria-hidden="true" />
                  </button>
                ) : null}
              </div>
              <AnimatePresence initial={false} mode="popLayout">
              {peopleExpanded ? (
                <motion.div
                  className="collab-people-body"
                  id={peopleBodyId}
                  key="people-body"
                  initial={{ opacity: 0, scaleY: 0.98 }}
                  animate={{ opacity: 1, scaleY: 1 }}
                  exit={{ opacity: 0, scaleY: 0.98 }}
                  style={{ transformOrigin: "top" }}
                  transition={revealTransition}
                >
                  <MemberPresenceStrip members={collaboration.members} />
                  <div className="collab-member-list">
                    {collaboration.members.slice(0, 6).map((member) => <MemberPresenceRow member={member} key={member.id} />)}
                  </div>
                </motion.div>
              ) : null}
              </AnimatePresence>
            </motion.section>

            <WriterControlStatus
              control={collaboration.writerControl}
              offline={offline}
              busy={collaboration.busy.has("request-control") || collaboration.busy.has("release-control")}
              onRequestControl={collaboration.requestWriterControl}
              onReleaseControl={collaboration.releaseWriterControl}
            />

            <section className="collab-annotations-section">
              <div className="collab-annotation-heading">
                <div>
                  <strong>Annotations</strong>
                  <small>{open.length}</small>
                </div>
                <div>
                  <button
                    type="button"
                    className={currentFileOnly ? "is-active" : ""}
                    disabled={!activePath}
                    aria-pressed={currentFileOnly}
                    title={activePath ? "Only this file" : "Open a file to filter"}
                    onClick={() => setCurrentFileOnly((value) => !value)}
                  >
                    <AnimatePresence initial={false}>
                      {currentFileOnly ? <motion.span className="collab-filter-indicator" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={revealTransition} /> : null}
                    </AnimatePresence>
                    <Filter aria-hidden="true" />
                    File
                  </button>
                  {onStartAnnotation ? (
                    <button type="button" disabled={!activePath} aria-label="New annotation" title="New annotation" onClick={onStartAnnotation}>
                      <Plus aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="collab-annotation-list">
                <AnimatePresence initial={false} mode="sync">
                {open.map((annotation) => (
                  <AnnotationRow
                    key={annotation.id}
                    annotation={annotation}
                    selected={annotation.id === selectedAnnotationId}
                    onSelect={() => onSelectAnnotation(annotation)}
                    onFocus={onFocusAnnotation ? () => onFocusAnnotation(annotation) : undefined}
                  />
                ))}
                {open.length === 0 ? (
                  <motion.div className="collab-annotation-empty" key="annotation-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
                    <MessageSquareText aria-hidden="true" />
                    <span>{query ? "No matching annotations" : currentFileOnly ? "No annotations in this file" : "No open annotations"}</span>
                  </motion.div>
                ) : null}
                </AnimatePresence>
              </div>

              {resolved.length > 0 ? (
                <details className="collab-resolved-list">
                  <summary>Resolved <small>{resolved.length}</small></summary>
                  {resolved.map((annotation) => (
                    <AnnotationRow
                      key={annotation.id}
                      annotation={annotation}
                      selected={annotation.id === selectedAnnotationId}
                      onSelect={() => onSelectAnnotation(annotation)}
                      onFocus={onFocusAnnotation ? () => onFocusAnnotation(annotation) : undefined}
                    />
                  ))}
                </details>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
      <div className="sidebar-scrollbar" aria-hidden="true"><span /></div>
    </aside>
  );
}
