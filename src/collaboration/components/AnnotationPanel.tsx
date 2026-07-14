import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  Circle,
  Crosshair,
  LoaderCircle,
  MessageSquareText,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import type { AnnotationAnchor, CodeAnnotation } from "../types";
import { MemberAvatar } from "./MemberPresence";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export interface AnnotationPanelProps {
  annotation: CodeAnnotation | null;
  draftAnchor?: AnnotationAnchor | null;
  loading?: boolean;
  busy?: boolean;
  error?: string | null;
  canCompose?: boolean;
  onClose: () => void;
  onFocusAnchor?: (anchor: AnnotationAnchor) => void;
  onCreate: (anchor: AnnotationAnchor, body: string) => void | CodeAnnotation | null | Promise<CodeAnnotation | null>;
  onReply: (annotationId: string, body: string) => void | CodeAnnotation | null | Promise<CodeAnnotation | null>;
  onResolve: (annotationId: string, resolved: boolean) => void | CodeAnnotation | null | Promise<CodeAnnotation | null>;
}

function anchorLabel(anchor: AnnotationAnchor) {
  return anchor.startLine === anchor.endLine
    ? `Line ${anchor.startLine}`
    : `Lines ${anchor.startLine}–${anchor.endLine}`;
}

function dateTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function panelTitle(annotation: CodeAnnotation | null) {
  const body = annotation?.messages[0]?.body.trim();
  if (!body) return annotation ? "Annotation" : "New annotation";
  return body.length > 54 ? `${body.slice(0, 53)}…` : body;
}

export function AnnotationPanel({
  annotation,
  draftAnchor = null,
  loading = false,
  busy = false,
  error = null,
  canCompose = true,
  onClose,
  onFocusAnchor,
  onCreate,
  onReply,
  onResolve,
}: AnnotationPanelProps) {
  const [body, setBody] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerId = useId();
  const anchor = annotation?.anchor ?? draftAnchor;
  const resolved = annotation?.status === "resolved";
  const title = useMemo(() => panelTitle(annotation), [annotation]);
  const bodyBytes = useMemo(() => new TextEncoder().encode(body.trim()).byteLength, [body]);
  const bodyTooLong = bodyBytes > 4_096;

  useEffect(() => {
    setBody("");
    setValidationError(null);
    if (!annotation && draftAnchor) textareaRef.current?.focus();
  }, [annotation?.id, draftAnchor?.path, draftAnchor?.startLine, draftAnchor?.endLine]);

  const submit = async () => {
    const value = body.trim();
    if (!value) {
      setValidationError("Write a comment first.");
      textareaRef.current?.focus();
      return;
    }
    if (new TextEncoder().encode(value).byteLength > 4_096) {
      setValidationError("Comments are limited to 4 KiB.");
      return;
    }
    const result = annotation
      ? await onReply(annotation.id, value)
      : anchor ? await onCreate(anchor, value) : null;
    if (result) {
      setBody("");
      setValidationError(null);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <motion.section
      className={`project-map-panel collab-annotation-panel ${anchor ? "has-anchor" : "without-anchor"}`}
      aria-label={annotation ? "Annotation thread" : "New annotation"}
      aria-busy={loading || busy}
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={revealTransition}
    >
      <header>
        <div>
          <span className="eyebrow">{annotation ? "Annotation" : "New annotation"}</span>
          <strong title={title}>{title}</strong>
        </div>
        <div className="collab-panel-actions">
          {annotation ? (
            <button
              type="button"
              disabled={busy}
              aria-label={resolved ? "Reopen annotation" : "Resolve annotation"}
              title={resolved ? "Reopen" : "Resolve"}
              onClick={() => void onResolve(annotation.id, !resolved)}
            >
              <AnimatePresence initial={false} mode="wait">
                <motion.span key={resolved ? "reopen" : "resolve"} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={revealTransition}>
                  {resolved ? <RotateCcw aria-hidden="true" /> : <Check aria-hidden="true" />}
                </motion.span>
              </AnimatePresence>
            </button>
          ) : null}
          <button type="button" aria-label="Close annotation" title="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <AnimatePresence initial={false} mode="popLayout">
      {anchor ? (
        onFocusAnchor ? (
          <motion.button type="button" className="collab-anchor-row" key="anchor-button" onClick={() => onFocusAnchor(anchor)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <Crosshair aria-hidden="true" />
            <span><strong>{anchor.path}</strong><small>{anchorLabel(anchor)}</small></span>
            <span>Show</span>
          </motion.button>
        ) : (
          <motion.div className="collab-anchor-row" key="anchor-copy" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <Crosshair aria-hidden="true" />
            <span><strong>{anchor.path}</strong><small>{anchorLabel(anchor)}</small></span>
          </motion.div>
        )
      ) : null}
      </AnimatePresence>

      <div className="collab-thread-scroll">
        <AnimatePresence initial={false} mode="wait">
        {loading && !annotation ? (
          <motion.div className="collab-panel-state" role="status" key="annotation-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <LoaderCircle className="collab-spin" aria-hidden="true" />
            <span>Loading annotation…</span>
          </motion.div>
        ) : null}

        {!loading && !annotation && !draftAnchor ? (
          <motion.div className="collab-panel-state" key="annotation-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <MessageSquareText aria-hidden="true" />
            <strong>Select an annotation</strong>
            <span>Code context and replies will appear here.</span>
          </motion.div>
        ) : null}

        {annotation ? (
          <motion.div className="collab-thread-messages" key={`thread-${annotation.id}`} initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -4 }} transition={revealTransition}>
            <AnimatePresence initial={false} mode="popLayout">
            {annotation.messages.map((message) => (
              <motion.article className={`collab-thread-message is-${message.syncStatus}`} key={message.id} layout="position" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={layoutTransition}>
                <MemberAvatar member={message.author} />
                <div>
                  <header>
                    <strong>{message.author.displayName}</strong>
                    {message.author.isLocal ? <small>you</small> : null}
                    <time dateTime={message.createdAt}>{dateTime(message.createdAt)}</time>
                  </header>
                  <p>{message.body}</p>
                  {message.syncStatus !== "synced" ? (
                    <span className="collab-message-sync">
                      <i />{message.syncStatus === "pending" ? "Waiting to sync" : "Couldn’t sync"}
                    </span>
                  ) : null}
                </div>
              </motion.article>
            ))}
            </AnimatePresence>

            <AnimatePresence initial={false} mode="popLayout">
            {resolved ? (
              <motion.div className="collab-resolved-event" key="resolved-event" initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={revealTransition}>
                <Check aria-hidden="true" />
                <span>
                  Resolved{annotation.resolvedBy ? ` by ${annotation.resolvedBy.displayName}` : ""}
                  {annotation.resolvedAt ? <time dateTime={annotation.resolvedAt}>{dateTime(annotation.resolvedAt)}</time> : null}
                </span>
              </motion.div>
            ) : null}
            </AnimatePresence>
          </motion.div>
        ) : draftAnchor ? (
          <motion.div className="collab-new-annotation-context" key="new-annotation" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={revealTransition}>
            <Circle aria-hidden="true" />
            <p>Start a written thread on this code. Teammates can reply without taking editor control.</p>
          </motion.div>
        ) : null}
        </AnimatePresence>
      </div>

      {anchor ? (
        <div className="collab-composer">
          <AnimatePresence initial={false} mode="popLayout">
            {error || validationError ? <motion.p role="status" key="composer-error" initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={revealTransition}>{validationError ?? error}</motion.p> : null}
          </AnimatePresence>
          <label htmlFor={composerId}>
            {annotation ? "Reply to annotation" : "Annotation"}
          </label>
          <textarea
            id={composerId}
            ref={textareaRef}
            rows={3}
            maxLength={4_096}
            value={body}
            disabled={!canCompose || busy || resolved}
            placeholder={resolved ? "Reopen this annotation to reply" : annotation ? "Reply…" : "Leave context for your team…"}
            onChange={(event) => {
              const nextBody = event.target.value;
              setBody(nextBody);
              setValidationError(
                new TextEncoder().encode(nextBody.trim()).byteLength > 4_096
                  ? "Comments are limited to 4 KiB."
                  : null,
              );
            }}
            onKeyDown={onComposerKeyDown}
          />
          <footer>
            <span>{body.length ? `${bodyBytes}/4096 bytes` : "⌘↵ to send"}</span>
            <button type="button" disabled={!canCompose || busy || resolved || bodyTooLong || !body.trim()} onClick={() => void submit()}>
              <AnimatePresence initial={false} mode="wait">
                <motion.span key={busy ? "sending" : "send"} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={revealTransition}>
                  {busy ? <LoaderCircle className="collab-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}
                </motion.span>
              </AnimatePresence>
              {annotation ? "Reply" : "Add"}
            </button>
          </footer>
        </div>
      ) : null}
    </motion.section>
  );
}
