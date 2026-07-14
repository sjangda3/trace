import { Cloud, CloudOff, LoaderCircle, RotateCw, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type {
  CollaborationConnectionStatus,
  CollaborationMember,
  CollaborationSyncStatus,
} from "../types";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export interface MemberAvatarProps {
  member: CollaborationMember;
  size?: "small" | "regular";
  title?: string;
}

export function MemberAvatar({ member, size = "regular", title }: MemberAvatarProps) {
  const initials = member.initials.trim().slice(0, 2).toLocaleUpperCase() || "?";
  return (
    <span
      className={`collab-member-avatar is-${member.accent} is-${size}`}
      title={title ?? member.displayName}
      aria-label={member.displayName}
    >
      <span aria-hidden="true">{initials}</span>
      <AnimatePresence initial={false} mode="wait">
        <motion.i
          className={`is-${member.presence}`}
          aria-label={`${member.presence} presence`}
          key={member.presence}
          initial={{ opacity: 0, scale: 0.7 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.7 }}
          transition={revealTransition}
        />
      </AnimatePresence>
    </span>
  );
}

function activeLabel(member: CollaborationMember) {
  if (member.isTyping) return "Typing";
  if (member.activePath) return member.activePath;
  if (member.presence === "active") return "In workspace";
  if (member.presence === "idle") return "Idle";
  return "Offline";
}

export interface MemberPresenceRowProps {
  member: CollaborationMember;
  selected?: boolean;
  onSelect?: (member: CollaborationMember) => void;
}

export function MemberPresenceRow({ member, selected = false, onSelect }: MemberPresenceRowProps) {
  const copy = (
    <>
      <MemberAvatar member={member} />
      <span className="collab-member-copy">
        <strong>{member.displayName}{member.isLocal ? <small>you</small> : null}</strong>
        <span className={member.isTyping ? "is-typing" : ""}>{activeLabel(member)}</span>
      </span>
      {member.isTyping ? <span className="collab-typing-dots" aria-label="Typing"><i /><i /><i /></span> : null}
    </>
  );

  return onSelect ? (
    <motion.button
      type="button"
      className={`collab-member-row ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      layout="position"
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={layoutTransition}
      onClick={() => onSelect(member)}
    >
      {selected ? <motion.span className="collab-selection-indicator" layoutId="collab-selected-member" transition={revealTransition} /> : null}
      {copy}
    </motion.button>
  ) : <motion.div className="collab-member-row" layout="position" transition={layoutTransition}>{copy}</motion.div>;
}

export interface MemberPresenceStripProps {
  members: CollaborationMember[];
  maxVisible?: number;
  label?: string;
}

export function MemberPresenceStrip({ members, maxVisible = 5, label = "Workspace members" }: MemberPresenceStripProps) {
  const ordered = [...members].sort((left, right) => {
    if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
    const weight = { active: 0, idle: 1, offline: 2 } as const;
    return weight[left.presence] - weight[right.presence];
  });
  const visible = ordered.slice(0, Math.max(1, maxVisible));
  const hiddenCount = Math.max(0, ordered.length - visible.length);

  return (
    <div className="collab-presence-strip" aria-label={label}>
      <div>
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((member) => (
            <motion.span key={member.id} layout="position" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={layoutTransition}>
              <MemberAvatar member={member} size="small" />
            </motion.span>
          ))}
          {hiddenCount > 0 ? <motion.span key="overflow" className="collab-presence-overflow" layout="position" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={layoutTransition}>+{hiddenCount}</motion.span> : null}
        </AnimatePresence>
      </div>
      <span>{ordered.filter((member) => member.presence === "active").length} active</span>
    </div>
  );
}

export interface CollaborationSyncIndicatorProps {
  connection: CollaborationConnectionStatus;
  syncStatus: CollaborationSyncStatus;
  pendingOperations?: number;
  compact?: boolean;
}

export function CollaborationSyncIndicator({
  connection,
  syncStatus,
  pendingOperations = 0,
  compact = false,
}: CollaborationSyncIndicatorProps) {
  let label = "Synced";
  let state = "synced";
  let Icon = Cloud;

  if (connection === "offline" || syncStatus === "offline") {
    label = pendingOperations ? `Offline · ${pendingOperations} pending` : "Offline";
    state = "offline";
    Icon = CloudOff;
  } else if (connection === "unavailable") {
    label = "Not connected";
    state = "unavailable";
    Icon = CloudOff;
  } else if (connection === "error" || syncStatus === "conflict") {
    label = syncStatus === "conflict" ? "Sync conflict" : "Sync unavailable";
    state = "error";
    Icon = TriangleAlert;
  } else if (connection === "connecting" || connection === "syncing" || syncStatus === "syncing") {
    label = "Syncing";
    state = "syncing";
    Icon = LoaderCircle;
  } else if (syncStatus === "pending" || pendingOperations > 0) {
    label = `${pendingOperations || 1} pending`;
    state = "pending";
    Icon = RotateCw;
  }

  return (
    <span className={`collab-sync-indicator is-${state} ${compact ? "is-compact" : ""}`} title={label} aria-live="polite">
      <AnimatePresence initial={false} mode="wait">
        <motion.span className="collab-sync-icon" key={state} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.85 }} transition={revealTransition}>
          <Icon aria-hidden="true" />
        </motion.span>
      </AnimatePresence>
      {compact ? <span className="sr-only">{label}</span> : <motion.span key={label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={revealTransition}>{label}</motion.span>}
    </span>
  );
}
