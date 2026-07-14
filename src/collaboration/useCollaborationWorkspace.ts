import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CollaborationApiError, collaborationApi } from "./api";
import type {
  AnnotationAnchor,
  CodeAnnotation,
  CollaborationApi,
  CollaborationMember,
  CollaborationSnapshot,
  CollaborationSyncStatus,
  WriterControl,
} from "./types";

export type CollaborationOperation =
  | "snapshot"
  | "create-annotation"
  | "reply-annotation"
  | "resolve-annotation"
  | "request-control"
  | "release-control"
  | "mark-typing";

export type CollaborationControllerError = {
  operation: CollaborationOperation;
  code: string;
  message: string;
};

export interface CollaborationWorkspaceController {
  readonly workspaceId: string | null;
  readonly source: CollaborationApi["source"];
  readonly snapshot: CollaborationSnapshot | null;
  readonly members: CollaborationMember[];
  readonly annotations: CodeAnnotation[];
  readonly writerControl: WriterControl | null;
  readonly syncStatus: CollaborationSyncStatus;
  readonly loading: boolean;
  readonly busy: ReadonlySet<CollaborationOperation>;
  readonly error: CollaborationControllerError | null;
  refresh(): Promise<CollaborationSnapshot | null>;
  createAnnotation(anchor: AnnotationAnchor, body: string): Promise<CodeAnnotation | null>;
  replyAnnotation(annotationId: string, body: string): Promise<CodeAnnotation | null>;
  resolveAnnotation(annotationId: string, resolved: boolean): Promise<CodeAnnotation | null>;
  requestWriterControl(): Promise<WriterControl | null>;
  releaseWriterControl(): Promise<WriterControl | null>;
  markTyping(): Promise<WriterControl | null>;
  clearError(): void;
}

export type UseCollaborationWorkspaceOptions = {
  api?: CollaborationApi;
};

function asControllerError(
  operation: CollaborationOperation,
  error: unknown,
): CollaborationControllerError {
  if (error instanceof CollaborationApiError) {
    return { operation, code: error.code, message: error.message };
  }
  return {
    operation,
    code: "COLLABORATION_ERROR",
    message: error instanceof Error ? error.message : "Collaboration could not be updated.",
  };
}

function validateBody(body: string): string {
  const value = body.trim();
  if (!value) throw new CollaborationApiError("ANNOTATION_BODY_REQUIRED", "Write a comment first.");
  if (new TextEncoder().encode(value).byteLength > 4_096) {
    throw new CollaborationApiError("ANNOTATION_BODY_TOO_LONG", "Comments are limited to 4 KiB.");
  }
  return value;
}

function validateAnchor(anchor: AnnotationAnchor): AnnotationAnchor {
  const path = anchor.path.trim();
  if (!path || path.startsWith("/") || path.includes("\0")) {
    throw new CollaborationApiError("INVALID_ANNOTATION_ANCHOR", "Choose a file inside the workspace.");
  }
  if (!Number.isSafeInteger(anchor.startLine) || anchor.startLine < 1) {
    throw new CollaborationApiError("INVALID_ANNOTATION_ANCHOR", "Choose a valid line in the editor.");
  }
  const endLine = Number.isSafeInteger(anchor.endLine)
    ? Math.max(anchor.startLine, anchor.endLine)
    : anchor.startLine;
  if (anchor.revision !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(anchor.revision)) {
    throw new CollaborationApiError("INVALID_ANNOTATION_ANCHOR", "The code revision is invalid.");
  }
  const revision = anchor.revision?.toLocaleLowerCase() ?? null;
  if (anchor.contentHash !== null && !/^[a-f0-9]{64}$/i.test(anchor.contentHash)) {
    throw new CollaborationApiError("INVALID_ANNOTATION_ANCHOR", "The code snapshot hash is invalid.");
  }
  return {
    path,
    startLine: anchor.startLine,
    endLine,
    revision,
    contentHash: anchor.contentHash?.toLocaleLowerCase() ?? null,
  };
}

export function useCollaborationWorkspace(
  workspaceId: string | null,
  options: UseCollaborationWorkspaceOptions = {},
): CollaborationWorkspaceController {
  const api = options.api ?? collaborationApi;
  const [snapshot, setSnapshot] = useState<CollaborationSnapshot | null>(null);
  const currentSnapshot = snapshot?.workspaceId === workspaceId ? snapshot : null;
  const [busy, setBusy] = useState<Set<CollaborationOperation>>(() => new Set());
  const [error, setError] = useState<CollaborationControllerError | null>(null);
  const generationRef = useRef(0);
  const refreshSequenceRef = useRef(0);
  const refreshInFlightRef = useRef(0);
  const workspaceIdRef = useRef(workspaceId);
  const snapshotRef = useRef(currentSnapshot);
  workspaceIdRef.current = workspaceId;
  snapshotRef.current = currentSnapshot;

  const markBusy = useCallback((operation: CollaborationOperation, value: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (value) next.add(operation);
      else next.delete(operation);
      return next;
    });
  }, []);

  const refresh = useCallback(async (): Promise<CollaborationSnapshot | null> => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId) return null;
    const generation = generationRef.current;
    const sequence = ++refreshSequenceRef.current;
    refreshInFlightRef.current += 1;
    if (refreshInFlightRef.current === 1) markBusy("snapshot", true);
    try {
      const next = await api.snapshot({ workspaceId: targetWorkspaceId });
      if (next.workspaceId !== targetWorkspaceId) {
        throw new CollaborationApiError("INVALID_SNAPSHOT", "The collaboration snapshot belongs to another workspace.");
      }
      if (
        generationRef.current !== generation ||
        workspaceIdRef.current !== targetWorkspaceId ||
        refreshSequenceRef.current !== sequence
      ) return null;
      setSnapshot(next);
      snapshotRef.current = next;
      setError(null);
      return next;
    } catch (caught) {
      if (
        generationRef.current === generation &&
        workspaceIdRef.current === targetWorkspaceId &&
        refreshSequenceRef.current === sequence
      ) {
        setError(asControllerError("snapshot", caught));
      }
      return null;
    } finally {
      if (generationRef.current === generation) {
        refreshInFlightRef.current = Math.max(0, refreshInFlightRef.current - 1);
        if (refreshInFlightRef.current === 0) markBusy("snapshot", false);
      }
    }
  }, [api, markBusy]);

  const updateAnnotation = useCallback((annotation: CodeAnnotation) => {
    setSnapshot((current) => {
      if (!current || current.workspaceId !== annotation.workspaceId) return current;
      const exists = current.annotations.some((candidate) => candidate.id === annotation.id);
      return {
        ...current,
        annotations: exists
          ? current.annotations.map((candidate) => candidate.id === annotation.id ? annotation : candidate)
          : [annotation, ...current.annotations],
      };
    });
  }, []);

  const runAnnotationMutation = useCallback(async (
    operation: Exclude<CollaborationOperation, "snapshot" | "request-control" | "release-control" | "mark-typing">,
    invoke: (targetWorkspaceId: string) => Promise<CodeAnnotation>,
  ): Promise<CodeAnnotation | null> => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId) return null;
    const generation = generationRef.current;
    markBusy(operation, true);
    try {
      const annotation = await invoke(targetWorkspaceId);
      if (generationRef.current !== generation || workspaceIdRef.current !== targetWorkspaceId) return null;
      updateAnnotation(annotation);
      setError(null);
      return annotation;
    } catch (caught) {
      if (generationRef.current === generation && workspaceIdRef.current === targetWorkspaceId) {
        setError(asControllerError(operation, caught));
      }
      return null;
    } finally {
      if (generationRef.current === generation) markBusy(operation, false);
    }
  }, [markBusy, updateAnnotation]);

  const createAnnotation = useCallback((anchor: AnnotationAnchor, body: string) => {
    return runAnnotationMutation(
      "create-annotation",
      (targetWorkspaceId) => api.createAnnotation({
        workspaceId: targetWorkspaceId,
        anchor: validateAnchor(anchor),
        body: validateBody(body),
      }),
    );
  }, [api, runAnnotationMutation]);

  const replyAnnotation = useCallback((annotationId: string, body: string) => {
    return runAnnotationMutation(
      "reply-annotation",
      (targetWorkspaceId) => api.replyAnnotation({
        workspaceId: targetWorkspaceId,
        annotationId,
        body: validateBody(body),
      }),
    );
  }, [api, runAnnotationMutation]);

  const resolveAnnotation = useCallback((annotationId: string, resolved: boolean) => {
    return runAnnotationMutation(
      "resolve-annotation",
      (targetWorkspaceId) => api.resolveAnnotation({ workspaceId: targetWorkspaceId, annotationId, resolved }),
    );
  }, [api, runAnnotationMutation]);

  const runControlMutation = useCallback(async (
    operation: "request-control" | "release-control",
    invoke: (targetWorkspaceId: string, control: WriterControl) => Promise<WriterControl>,
  ): Promise<WriterControl | null> => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId) return null;
    const currentControl = snapshotRef.current?.writerControl;
    if (!currentControl) return null;
    const generation = generationRef.current;
    markBusy(operation, true);
    try {
      const writerControl = await invoke(targetWorkspaceId, currentControl);
      if (generationRef.current !== generation || workspaceIdRef.current !== targetWorkspaceId) return null;
      setSnapshot((current) => current && current.workspaceId === targetWorkspaceId
        ? { ...current, writerControl }
        : current);
      if (snapshotRef.current?.workspaceId === targetWorkspaceId) {
        snapshotRef.current = { ...snapshotRef.current, writerControl };
      }
      setError(null);
      return writerControl;
    } catch (caught) {
      if (generationRef.current === generation && workspaceIdRef.current === targetWorkspaceId) {
        setError(asControllerError(operation, caught));
      }
      return null;
    } finally {
      if (generationRef.current === generation) markBusy(operation, false);
    }
  }, [markBusy]);

  const requestWriterControl = useCallback(() => runControlMutation(
    "request-control",
    (targetWorkspaceId, control) => api.requestWriterControl({
      workspaceId: targetWorkspaceId,
      expectedVersion: control.version,
    }),
  ), [api, runControlMutation]);

  const releaseWriterControl = useCallback(() => runControlMutation(
    "release-control",
    (targetWorkspaceId, control) => api.releaseWriterControl({
      workspaceId: targetWorkspaceId,
      expectedVersion: control.version,
      expectedFence: control.fence,
    }),
  ), [api, runControlMutation]);

  const markTyping = useCallback(async (): Promise<WriterControl | null> => {
    const targetWorkspaceId = workspaceIdRef.current;
    const currentControl = snapshotRef.current?.writerControl;
    if (!targetWorkspaceId || !currentControl?.ownerIsLocal) return null;
    const generation = generationRef.current;
    try {
      const writerControl = await api.markTyping({
        workspaceId: targetWorkspaceId,
        expectedFence: currentControl.fence,
      });
      if (generationRef.current !== generation || workspaceIdRef.current !== targetWorkspaceId) return null;
      setSnapshot((current) => current && current.workspaceId === targetWorkspaceId
        ? { ...current, writerControl }
        : current);
      if (snapshotRef.current?.workspaceId === targetWorkspaceId) {
        snapshotRef.current = { ...snapshotRef.current, writerControl };
      }
      return writerControl;
    } catch (caught) {
      if (generationRef.current === generation && workspaceIdRef.current === targetWorkspaceId) {
        setError(asControllerError("mark-typing", caught));
      }
      return null;
    }
  }, [api]);

  useEffect(() => {
    generationRef.current += 1;
    refreshSequenceRef.current += 1;
    refreshInFlightRef.current = 0;
    snapshotRef.current = null;
    setSnapshot(null);
    setBusy(new Set());
    setError(null);
    if (!workspaceId) return;
    void refresh();
  }, [refresh, workspaceId]);

  useEffect(() => api.onDidChange((event) => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId || event.workspaceId !== targetWorkspaceId) return;
    if (event.snapshot?.workspaceId === targetWorkspaceId) {
      refreshSequenceRef.current += 1;
      snapshotRef.current = event.snapshot;
      setSnapshot(event.snapshot);
      return;
    }
    if (event.reason === "control") {
      snapshotRef.current = null;
      setSnapshot(null);
    }
    void refresh();
  }), [api, refresh]);

  return useMemo(() => ({
    workspaceId,
    source: api.source,
    snapshot: currentSnapshot,
    members: currentSnapshot?.members ?? [],
    annotations: currentSnapshot?.annotations ?? [],
    writerControl: currentSnapshot?.writerControl ?? null,
    syncStatus: currentSnapshot?.syncStatus ?? "idle",
    loading: busy.has("snapshot") && !currentSnapshot,
    busy,
    error,
    refresh,
    createAnnotation,
    replyAnnotation,
    resolveAnnotation,
    requestWriterControl,
    releaseWriterControl,
    markTyping,
    clearError: () => setError(null),
  }), [
    api.source,
    busy,
    createAnnotation,
    error,
    refresh,
    markTyping,
    releaseWriterControl,
    replyAnnotation,
    requestWriterControl,
    resolveAnnotation,
    currentSnapshot,
    workspaceId,
  ]);
}
