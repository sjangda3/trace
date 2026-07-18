import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalApi, type TerminalEvent, type TerminalSession } from ".";
import { terminalMetrics, terminalPalette } from "../preferences/presentation";
import type { Accent, CodeSize, ResolvedAppearance } from "../preferences/types";

export function XtermSurface({
  session,
  active,
  drawerOpen,
  resolvedAppearance,
  accent,
  codeSize,
  pendingAction,
  onError,
}: {
  session: TerminalSession;
  active: boolean;
  drawerOpen: boolean;
  resolvedAppearance: ResolvedAppearance;
  accent: Accent;
  codeSize: CodeSize;
  pendingAction: "closing" | "requesting-control" | null;
  onError: (message: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef(session);
  const visibleRef = useRef(active && drawerOpen);
  const lastSizeRef = useRef({ cols: session.cols, rows: session.rows });
  const appearanceRef = useRef({ resolvedAppearance, accent, codeSize });

  sessionRef.current = session;
  visibleRef.current = active && drawerOpen;
  appearanceRef.current = { resolvedAppearance, accent, codeSize };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const initialAppearance = appearanceRef.current;
    const initialMetrics = terminalMetrics(initialAppearance.codeSize);
    const terminal = new Terminal({
      fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, monospace',
      fontSize: initialMetrics.fontSize,
      fontWeight: "400",
      lineHeight: initialMetrics.lineHeight,
      letterSpacing: 0,
      cursorStyle: "block",
      cursorBlink: true,
      cursorWidth: 1,
      scrollback: 5_000,
      allowTransparency: true,
      convertEol: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      screenReaderMode: false,
      theme: terminalPalette(initialAppearance.resolvedAppearance, initialAppearance.accent),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminal.options.disableStdin = !sessionRef.current.control.localHasControl || sessionRef.current.exited;
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let disposed = false;
    let replayReady = false;
    let lastSequence = 0;
    let exitRendered = false;
    let processExited = sessionRef.current.exited;
    let latestControlVersion = sessionRef.current.control.version;
    let pendingExit: Extract<TerminalEvent, { type: "exit" }> | null = null;
    const queuedData: Array<{ sequence: number; data: string }> = [];
    const acknowledge = (sequence: number) => {
      if (disposed) return;
      const current = sessionRef.current;
      terminalApi.ack({ workspaceId: current.workspaceId, sessionId: current.id, sequence });
    };
    const writeExit = (event: { exitCode: number | null; signal: number | null }) => {
      if (exitRendered || disposed) return;
      exitRendered = true;
      processExited = true;
      const detail = event.signal
        ? `signal ${event.signal}`
        : `code ${event.exitCode ?? 0}`;
      terminal.write(`\r\n\x1b[90m[process exited with ${detail}]\x1b[0m\r\n`);
      terminal.options.disableStdin = true;
    };
    const disposeEvents = terminalApi.onEvent((event) => {
      if (event.workspaceId !== sessionRef.current.workspaceId || event.sessionId !== sessionRef.current.id) return;
      if (event.type === "data") {
        if (event.sequence <= lastSequence) return;
        lastSequence = event.sequence;
        if (replayReady) terminal.write(event.data, () => acknowledge(event.sequence));
        else queuedData.push({ sequence: event.sequence, data: event.data });
      }
      if (event.type === "exit") {
        if (replayReady) writeExit(event);
        else pendingExit = event;
      }
      if (event.type === "control" && event.control.version >= latestControlVersion) {
        latestControlVersion = event.control.version;
        terminal.options.disableStdin = !event.control.localHasControl || processExited;
      }
    });

    const attachedSession = sessionRef.current;
    void terminalApi.attach({
      workspaceId: attachedSession.workspaceId,
      sessionId: attachedSession.id,
    }).then((snapshot) => {
      if (disposed) return;
      lastSequence = Math.max(lastSequence, snapshot.sequence);
      processExited = processExited || snapshot.exited;
      if (snapshot.control.version >= latestControlVersion) {
        latestControlVersion = snapshot.control.version;
        terminal.options.disableStdin = !snapshot.control.localHasControl || processExited;
      } else if (snapshot.exited) {
        terminal.options.disableStdin = true;
      }

      const drainReplay = (prefix: string, acknowledgedSequence: number) => {
        if (disposed) return;
        const chunks = queuedData
          .filter(({ sequence }) => sequence > snapshot.sequence)
          .sort((left, right) => left.sequence - right.sequence);
        queuedData.length = 0;
        const finalSequence = chunks.at(-1)?.sequence ?? acknowledgedSequence;
        const output = prefix + chunks.map(({ data }) => data).join("");
        const onWritten = () => {
          if (disposed) return;
          acknowledge(finalSequence);
          if (queuedData.some(({ sequence }) => sequence > finalSequence)) {
            drainReplay("", finalSequence);
            return;
          }
          replayReady = true;
          if (pendingExit) writeExit(pendingExit);
          else if (snapshot.exited) writeExit(snapshot);
        };
        if (output.length > 0) terminal.write(output, onWritten);
        else queueMicrotask(onWritten);
      };
      drainReplay(snapshot.output, snapshot.sequence);
    }).catch((error: unknown) => {
      if (!disposed) onError(error instanceof Error ? error.message : "The terminal could not be attached.");
    });

    const inputDisposable = terminal.onData((data) => {
      const current = sessionRef.current;
      if (terminal.options.disableStdin || current.exited) return;
      terminalApi.write({ workspaceId: current.workspaceId, sessionId: current.id, data });
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const current = sessionRef.current;
      if (!visibleRef.current || terminal.options.disableStdin || current.exited) return;
      if (cols === lastSizeRef.current.cols && rows === lastSizeRef.current.rows) return;
      lastSizeRef.current = { cols, rows };
      void terminalApi.resize({
        workspaceId: current.workspaceId,
        sessionId: current.id,
        cols,
        rows,
      }).catch((error: unknown) => {
        onError(error instanceof Error ? error.message : "The terminal could not be resized.");
      });
    });

    let animationFrame = 0;
    const fit = () => {
      if (disposed || !visibleRef.current || !host.isConnected) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
        } catch {
          // The drawer can become hidden between measuring and fitting.
        }
      });
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resizeObserver?.observe(host);
    void document.fonts?.ready.then(fit);
    fit();

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      resizeDisposable.dispose();
      inputDisposable.dispose();
      disposeEvents();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [onError]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !session.control.localHasControl || session.exited;
  }, [session.control.localHasControl, session.exited]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const metrics = terminalMetrics(codeSize);
    terminal.options.theme = terminalPalette(resolvedAppearance, accent);
    terminal.options.fontSize = metrics.fontSize;
    terminal.options.lineHeight = metrics.lineHeight;
    const frame = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // The terminal may be hidden while a preference is changing.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [accent, codeSize, resolvedAppearance]);

  useEffect(() => {
    if (!active || !drawerOpen) return;
    const frame = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      } catch {
        // The drawer may have closed before the next frame.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, drawerOpen]);

  return (
    <div
      ref={hostRef}
      className={`terminal-xterm-host ${pendingAction ? `is-${pendingAction}` : ""}`}
      hidden={!active}
      aria-label={`${session.title} terminal`}
      aria-busy={pendingAction === "closing" || undefined}
      data-pending-action={pendingAction ?? undefined}
    />
  );
}
