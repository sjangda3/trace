import { Clock3, Keyboard, LoaderCircle, LockKeyhole, UnlockKeyhole } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { WriterControl } from "../types";

const revealTransition = { type: "tween" as const, duration: 0.12 };

export interface WriterControlStatusProps {
  control: WriterControl | null;
  offline?: boolean;
  busy?: boolean;
  onRequestControl?: () => void | Promise<WriterControl | null>;
  onReleaseControl?: () => void | Promise<WriterControl | null>;
}

function controlCopy(control: WriterControl | null, offline: boolean) {
  if (offline) return { title: "Editor control paused", detail: "Reconnect to change the writer." };
  if (!control) return { title: "Checking editor control", detail: "One teammate writes at a time." };
  if (control.ownerIsLocal) {
    return {
      title: "You have editor control",
      detail: control.typingCount > 0 ? "Your changes are live." : "The editor is ready for you.",
    };
  }
  if (control.ownerName) {
    return {
      title: `${control.ownerName} is editing`,
      detail: control.typingCount > 0
        ? "Control unlocks when typing stops."
        : control.requestedByLocal ? "Your request is waiting." : "You can request control now.",
    };
  }
  return { title: "Editor is available", detail: "Take control before typing." };
}

export function WriterControlStatus({
  control,
  offline = false,
  busy = false,
  onRequestControl,
  onReleaseControl,
}: WriterControlStatusProps) {
  const copy = controlCopy(control, offline);
  const localHasControl = Boolean(control?.ownerIsLocal);
  const typing = (control?.typingCount ?? 0) > 0;
  const canRequest = Boolean(
    control &&
    !offline &&
    !localHasControl &&
    control.requestable &&
    !typing &&
    !control.requestedByLocal &&
    onRequestControl,
  );
  const StateIcon = offline || control?.mode === "blocked"
    ? LockKeyhole
    : localHasControl ? Keyboard : control?.ownerId ? Clock3 : UnlockKeyhole;

  return (
    <motion.section className={`collab-writer-control ${localHasControl ? "is-local" : ""}`} aria-label="Editor control" aria-busy={busy} layout transition={revealTransition}>
      <AnimatePresence initial={false} mode="wait">
        <motion.span className="collab-control-icon" key={copy.title} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={revealTransition}>
          <StateIcon aria-hidden="true" />
        </motion.span>
      </AnimatePresence>
      <AnimatePresence initial={false} mode="wait">
        <motion.span key={copy.title} initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={revealTransition}>
          <strong>{copy.title}</strong>
          <small>{copy.detail}</small>
        </motion.span>
      </AnimatePresence>
      {localHasControl && onReleaseControl ? (
        <button type="button" disabled={busy || offline || typing} onClick={() => void onReleaseControl()}>
          {busy ? <LoaderCircle className="collab-spin" aria-hidden="true" /> : null}
          Release
        </button>
      ) : onRequestControl && control ? (
        <button
          type="button"
          disabled={!canRequest || busy}
          title={typing ? "Available when everyone stops typing" : undefined}
          onClick={() => void onRequestControl()}
        >
          {busy ? <LoaderCircle className="collab-spin" aria-hidden="true" /> : null}
          {control.requestedByLocal ? "Waiting" : control.ownerId ? "Request" : "Take"}
        </button>
      ) : null}
    </motion.section>
  );
}
