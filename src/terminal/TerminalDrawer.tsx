import { LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { Accent, CodeSize, ResolvedAppearance } from "../preferences/types";
import { XtermSurface } from "./XtermSurface";
import { useTerminalSessions } from "./useTerminalSessions";

type TerminalState = ReturnType<typeof useTerminalSessions>;

function DrawerIconButton({
  label,
  onClick,
  disabled = false,
  busy = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={`icon-button terminal-action-button ${busy ? "is-pending" : ""}`}
      type="button"
      aria-label={label}
      aria-busy={busy || undefined}
      title={label}
      data-state={busy ? "pending" : "idle"}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function TerminalDrawer({
  open,
  terminal,
  resolvedAppearance,
  accent,
  codeSize,
  onClose,
}: {
  open: boolean;
  terminal: TerminalState;
  resolvedAppearance: ResolvedAppearance;
  accent: Accent;
  codeSize: CodeSize;
  onClose: () => void;
}) {
  const active = terminal.activeSession;
  const activeClosing = Boolean(active && terminal.closingSessionId === active.id);
  const activeRequestingControl = Boolean(active && terminal.requestingControlSessionId === active.id);
  const initialBusy = terminal.sessions.length === 0 && (terminal.loading || terminal.creating);
  let controlLabel = initialBusy ? "Starting terminal" : "No terminal selected";
  if (activeClosing) controlLabel = "Closing terminal";
  else if (activeRequestingControl) controlLabel = "Requesting terminal control";
  else if (active?.exited) controlLabel = "Process exited";
  else if (active?.control.localHasControl) controlLabel = "You have control";
  else if (active) controlLabel = `${active.control.ownerName ?? "A teammate"} has control`;

  return (
    <motion.section
      className={`terminal-drawer ${initialBusy ? "is-loading" : ""} ${terminal.creating ? "is-creating" : ""} ${terminal.closingSessionId ? "is-closing-session" : ""} ${terminal.requestingControlSessionId ? "is-requesting-control" : ""}`}
      aria-label="Integrated terminal"
      aria-hidden={!open}
      aria-busy={initialBusy || undefined}
      inert={!open}
      initial={false}
      animate={{
        opacity: open ? 1 : 0,
        y: open ? 0 : 12,
        transitionEnd: { visibility: open ? "visible" : "hidden" },
      }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      style={{ pointerEvents: open ? "auto" : "none" }}
    >
      <div className="terminal-header">
        <div className="terminal-tabs" role="tablist" aria-label="Bottom panel">
          <strong role="tab" aria-selected="true">Terminal</strong>
          <span role="tab" aria-selected="false">Problems</span>
          <span role="tab" aria-selected="false">Output</span>
        </div>
        <div className="terminal-controls">
          {terminal.sessions.length > 0 ? (
            <select
              aria-label="Active terminal"
              value={terminal.activeSessionId ?? ""}
              onChange={(event) => terminal.selectSession(event.target.value)}
            >
              {terminal.sessions.map((session, index) => (
                <option key={session.id} value={session.id}>
                  {session.title} {index + 1}
                  {session.id === terminal.closingSessionId
                    ? " — closing"
                    : session.id === terminal.requestingControlSessionId
                      ? " — requesting control"
                      : session.exited ? " — exited" : ""}
                </option>
              ))}
            </select>
          ) : null}
          <DrawerIconButton
            label={terminal.creating ? "Creating terminal" : "New terminal"}
            busy={terminal.creating}
            onClick={() => void terminal.createSession()}
            disabled={terminal.loading || terminal.creating}
          >
            {terminal.creating
              ? <LoaderCircle className="terminal-action-spinner" aria-hidden="true" />
              : <Plus aria-hidden="true" />}
          </DrawerIconButton>
          <DrawerIconButton
            label={activeClosing ? "Closing terminal" : "Kill terminal"}
            busy={activeClosing}
            onClick={() => active && void terminal.closeSession(active.id)}
            disabled={!active || terminal.closingSessionId !== null || activeRequestingControl}
          >
            {activeClosing
              ? <LoaderCircle className="terminal-action-spinner" aria-hidden="true" />
              : <Trash2 aria-hidden="true" />}
          </DrawerIconButton>
          <span
            className={`control-owner ${activeRequestingControl ? "is-pending" : ""}`}
            aria-live="polite"
            aria-busy={activeRequestingControl || undefined}
            data-state={activeRequestingControl ? "pending" : "idle"}
          >
            {controlLabel}{active?.control.typingCount ? " · typing" : ""}
          </span>
          <button
            type="button"
            className={`terminal-control-button ${activeRequestingControl ? "is-pending" : ""}`}
            aria-busy={activeRequestingControl || undefined}
            data-state={activeRequestingControl ? "pending" : "idle"}
            disabled={
              !active ||
              active.exited ||
              active.control.localHasControl ||
              active.control.typingCount > 0 ||
              terminal.requestingControlSessionId !== null ||
              activeClosing
            }
            onClick={() => active && void terminal.requestControl(active.id)}
          >
            {activeRequestingControl ? (
              <><LoaderCircle className="terminal-action-spinner" aria-hidden="true" />Requesting…</>
            ) : active?.control.localHasControl ? "In control" : "Take control"}
          </button>
          <DrawerIconButton label="Close terminal" onClick={onClose}><X aria-hidden="true" /></DrawerIconButton>
        </div>
      </div>
      <div className="terminal-body">
        {initialBusy ? (
          <div className="terminal-loading"><LoaderCircle aria-hidden="true" />Starting terminal…</div>
        ) : null}
        {terminal.sessions.map((session) => (
          <XtermSurface
            key={session.id}
            session={session}
            active={session.id === terminal.activeSessionId}
            drawerOpen={open}
            resolvedAppearance={resolvedAppearance}
            accent={accent}
            codeSize={codeSize}
            pendingAction={
              session.id === terminal.closingSessionId
                ? "closing"
                : session.id === terminal.requestingControlSessionId ? "requesting-control" : null
            }
            onError={terminal.reportError}
          />
        ))}
        {terminal.error ? (
          <div className="terminal-inline-error" role="alert">
            <span>{terminal.error}</span>
            <button type="button" onClick={terminal.dismissError}>Dismiss</button>
          </div>
        ) : null}
      </div>
    </motion.section>
  );
}
