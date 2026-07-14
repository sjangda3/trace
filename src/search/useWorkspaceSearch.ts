import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkspaceSearchApiError, workspaceSearchApi } from "./api";
import type {
  WorkspaceSearchApi,
  WorkspaceSearchResult,
} from "./types";

export type WorkspaceSearchOptions = {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  maxResults?: number;
};

export type WorkspaceSearchError = {
  code: string;
  message: string;
};

export type WorkspaceSearchController = {
  source: WorkspaceSearchApi["source"];
  result: WorkspaceSearchResult | null;
  loading: boolean;
  error: WorkspaceSearchError | null;
  run(query: string, options?: WorkspaceSearchOptions): Promise<WorkspaceSearchResult | null>;
  cancel(): Promise<void>;
  clear(): void;
};

type ActiveSearch = {
  workspaceId: string;
  requestId: string;
  sequence: number;
};

function requestId() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `search-${suffix}`;
}

function toError(error: unknown): WorkspaceSearchError {
  if (error instanceof WorkspaceSearchApiError) return { code: error.code, message: error.message };
  return {
    code: "SEARCH_ERROR",
    message: error instanceof Error ? error.message : "Workspace search could not be completed.",
  };
}

function validateQuery(query: string) {
  if (!query || query.includes("\n") || query.includes("\r") || query.includes("\0")) {
    throw new WorkspaceSearchApiError("INVALID_REQUEST", "Enter a single-line search term.");
  }
  if (new TextEncoder().encode(query).length > 512) {
    throw new WorkspaceSearchApiError("INVALID_REQUEST", "Search terms are limited to 512 bytes.");
  }
  return query;
}

export function useWorkspaceSearch(
  workspaceId: string | null,
  api: WorkspaceSearchApi = workspaceSearchApi,
): WorkspaceSearchController {
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<WorkspaceSearchError | null>(null);
  const activeRef = useRef<ActiveSearch | null>(null);
  const workspaceIdRef = useRef(workspaceId);
  const sequenceRef = useRef(0);
  workspaceIdRef.current = workspaceId;

  const cancel = useCallback(async () => {
    sequenceRef.current += 1;
    const active = activeRef.current;
    if (!active) {
      setLoading(false);
      return;
    }
    activeRef.current = null;
    try {
      await api.cancel({ workspaceId: active.workspaceId, requestId: active.requestId });
    } catch {
      // The search may have completed between cancellation and delivery.
    } finally {
      if (!activeRef.current) setLoading(false);
    }
  }, [api]);

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  const run = useCallback(async (
    query: string,
    options: WorkspaceSearchOptions = {},
  ): Promise<WorkspaceSearchResult | null> => {
    const targetWorkspaceId = workspaceIdRef.current;
    if (!targetWorkspaceId) return null;
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    const previous = activeRef.current;
    activeRef.current = null;
    setLoading(true);
    setError(null);
    if (previous) {
      try {
        await api.cancel({ workspaceId: previous.workspaceId, requestId: previous.requestId });
      } catch {
        // The previous search may have completed while cancellation was delivered.
      }
    }
    if (
      sequenceRef.current !== sequence ||
      workspaceIdRef.current !== targetWorkspaceId
    ) return null;
    const active: ActiveSearch = {
      workspaceId: targetWorkspaceId,
      requestId: requestId(),
      sequence,
    };
    activeRef.current = active;
    try {
      const next = await api.search({
        workspaceId: targetWorkspaceId,
        requestId: active.requestId,
        query: validateQuery(query),
        caseSensitive: Boolean(options.caseSensitive),
        wholeWord: Boolean(options.wholeWord),
        maxResults: options.maxResults ?? 500,
      });
      if (
        activeRef.current?.requestId !== active.requestId ||
        activeRef.current.sequence !== sequence ||
        workspaceIdRef.current !== targetWorkspaceId
      ) return null;
      setResult(next);
      return next;
    } catch (caught) {
      if (
        activeRef.current?.requestId === active.requestId &&
        workspaceIdRef.current === targetWorkspaceId
      ) {
        const nextError = toError(caught);
        if (nextError.code !== "SEARCH_CANCELLED") setError(nextError);
      }
      return null;
    } finally {
      if (activeRef.current?.requestId === active.requestId) {
        activeRef.current = null;
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    const active = activeRef.current;
    activeRef.current = null;
    sequenceRef.current += 1;
    setResult(null);
    setError(null);
    setLoading(false);
    if (active) {
      void api.cancel({ workspaceId: active.workspaceId, requestId: active.requestId }).catch(() => {});
    }
  }, [api, workspaceId]);

  useEffect(() => () => {
    const active = activeRef.current;
    activeRef.current = null;
    if (active) {
      void api.cancel({ workspaceId: active.workspaceId, requestId: active.requestId }).catch(() => {});
    }
  }, [api]);

  return useMemo(() => ({
    source: api.source,
    result,
    loading,
    error,
    run,
    cancel,
    clear,
  }), [api.source, cancel, clear, error, loading, result, run]);
}
