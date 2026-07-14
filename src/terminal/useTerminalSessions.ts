import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { terminalApi, type TerminalSession } from ".";

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useTerminalSessions(workspaceId: string | null, open: boolean) {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [requestingControlSessionId, setRequestingControlSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  const creatingRef = useRef(false);
  const closingSessionIdRef = useRef<string | null>(null);
  const requestingControlSessionIdRef = useRef<string | null>(null);
  const createTokenRef = useRef(0);
  const loadGenerationRef = useRef(0);

  workspaceIdRef.current = workspaceId;

  useEffect(() => terminalApi.onEvent((event) => {
    if (!event.workspaceId || event.workspaceId !== workspaceIdRef.current) return;
    if (event.type === "exit") {
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? { ...session, exited: true, exitCode: event.exitCode, signal: event.signal }
        : session));
    }
    if (event.type === "control") {
      setSessions((current) => current.map((session) => session.id === event.sessionId
        ? event.control.version >= session.control.version
          ? { ...session, control: event.control }
          : session
        : session));
    }
    if (event.type === "input-rejected") setError(event.error.message);
  }), []);

  const loadSessions = useCallback(async (targetWorkspaceId: string) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    try {
      const loaded = await terminalApi.list(targetWorkspaceId);
      if (generation !== loadGenerationRef.current || workspaceIdRef.current !== targetWorkspaceId) return;
      setSessions(loaded);
      setActiveSessionId((current) => (
        current && loaded.some((session) => session.id === current)
          ? current
          : loaded.at(-1)?.id ?? null
      ));
    } catch (loadError) {
      if (generation === loadGenerationRef.current) {
        setError(errorMessage(loadError, "The terminal sessions could not be loaded."));
      }
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGenerationRef.current += 1;
    createTokenRef.current += 1;
    creatingRef.current = false;
    closingSessionIdRef.current = null;
    requestingControlSessionIdRef.current = null;
    setSessions([]);
    setActiveSessionId(null);
    setCreating(false);
    setClosingSessionId(null);
    setRequestingControlSessionId(null);
    setError(null);
    if (workspaceId) void loadSessions(workspaceId);
  }, [loadSessions, workspaceId]);

  const createSession = useCallback(async () => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId || creatingRef.current) return null;
    const generation = loadGenerationRef.current;
    const token = ++createTokenRef.current;
    creatingRef.current = true;
    setCreating(true);
    try {
      const session = await terminalApi.create({ workspaceId: targetWorkspaceId, cols: 100, rows: 8 });
      if (
        workspaceIdRef.current !== targetWorkspaceId ||
        loadGenerationRef.current !== generation ||
        createTokenRef.current !== token
      ) return null;
      setSessions((current) => current.some(({ id }) => id === session.id)
        ? current.map((item) => item.id === session.id ? session : item)
        : [...current, session]);
      setActiveSessionId(session.id);
      setError(null);
      return session;
    } catch (createError) {
      if (
        workspaceIdRef.current === targetWorkspaceId &&
        loadGenerationRef.current === generation &&
        createTokenRef.current === token
      ) setError(errorMessage(createError, "A new terminal could not be created."));
      return null;
    } finally {
      if (createTokenRef.current === token) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  }, []);

  useEffect(() => {
    if (open && workspaceId && !loading && sessions.length === 0 && !creatingRef.current) {
      void createSession();
    }
  }, [createSession, loading, open, sessions.length, workspaceId]);

  const closeSession = useCallback(async (sessionId: string) => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (
      !targetWorkspaceId ||
      closingSessionIdRef.current !== null ||
      requestingControlSessionIdRef.current === sessionId
    ) return;
    const generation = loadGenerationRef.current;
    closingSessionIdRef.current = sessionId;
    setClosingSessionId(sessionId);
    try {
      await terminalApi.close({ workspaceId: targetWorkspaceId, sessionId });
      if (workspaceIdRef.current !== targetWorkspaceId || loadGenerationRef.current !== generation) return;
      setSessions((current) => {
        const index = current.findIndex((session) => session.id === sessionId);
        const next = current.filter((session) => session.id !== sessionId);
        setActiveSessionId((active) => active === sessionId
          ? next[Math.min(Math.max(index, 0), next.length - 1)]?.id ?? null
          : active);
        return next;
      });
    } catch (closeError) {
      if (workspaceIdRef.current === targetWorkspaceId && loadGenerationRef.current === generation) {
        setError(errorMessage(closeError, "The terminal could not be closed."));
      }
    } finally {
      if (
        workspaceIdRef.current === targetWorkspaceId &&
        loadGenerationRef.current === generation &&
        closingSessionIdRef.current === sessionId
      ) {
        closingSessionIdRef.current = null;
        setClosingSessionId(null);
      }
    }
  }, []);

  const requestControl = useCallback(async (sessionId: string) => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (
      !targetWorkspaceId ||
      requestingControlSessionIdRef.current !== null ||
      closingSessionIdRef.current === sessionId
    ) return;
    const generation = loadGenerationRef.current;
    requestingControlSessionIdRef.current = sessionId;
    setRequestingControlSessionId(sessionId);
    try {
      const control = await terminalApi.requestControl({ workspaceId: targetWorkspaceId, sessionId });
      if (workspaceIdRef.current !== targetWorkspaceId || loadGenerationRef.current !== generation) return;
      setSessions((current) => current.map((session) => session.id === sessionId
        ? control.version >= session.control.version ? { ...session, control } : session
        : session));
      setError(null);
    } catch (controlError) {
      if (workspaceIdRef.current === targetWorkspaceId && loadGenerationRef.current === generation) {
        setError(errorMessage(controlError, "Terminal control could not be transferred."));
      }
    } finally {
      if (
        workspaceIdRef.current === targetWorkspaceId &&
        loadGenerationRef.current === generation &&
        requestingControlSessionIdRef.current === sessionId
      ) {
        requestingControlSessionIdRef.current = null;
        setRequestingControlSessionId(null);
      }
    }
  }, []);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );
  const reportError = useCallback((message: string) => setError(message), []);
  const dismissError = useCallback(() => setError(null), []);

  return {
    source: terminalApi.source,
    sessions,
    activeSession,
    activeSessionId,
    loading,
    creating,
    closingSessionId,
    requestingControlSessionId,
    error,
    selectSession: setActiveSessionId,
    createSession,
    closeSession,
    requestControl,
    reportError,
    dismissError,
  };
}
