import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitApiError, gitApi } from "./api";
import type {
  GitBranches,
  GitBranchMutationResult,
  GitCommitResult,
  GitConflicts,
  GitDiffRequest,
  GitDiffSelection,
  GitFileDiff,
  GitLog,
  GitStageResult,
  GitStatus,
} from "./types";

export type GitWorkspaceIntent = {
  branches?: boolean;
  history?: boolean;
  historyLimit?: number;
};

export type GitHistoryOptions = {
  maxCount?: number;
  skip?: number;
};

export type GitReadOperation = "status" | "branches" | "history" | "conflicts";
export type GitMutationOperation = "stage" | "unstage" | "commit" | "checkout-branch" | "create-branch";
export type GitOperationKey = GitReadOperation | GitMutationOperation | "diff";

export type GitWorkspaceError = {
  operation: GitOperationKey;
  code: string;
  message: string;
};

type WorkspaceIdentity = {
  workspaceId: string | null;
  generation: number;
};

type InFlightRead = {
  identity: WorkspaceIdentity;
  epoch: number;
  promise: Promise<unknown>;
};

type InFlightMutation = {
  identity: WorkspaceIdentity;
  promise: Promise<unknown>;
};

const CHANGE_DEBOUNCE_MS = 140;
const DEFAULT_HISTORY_LIMIT = 100;

function normalizedHistoryLimit(value: number | undefined) {
  return Number.isInteger(value) && value !== undefined && value >= 1 && value <= 200
    ? value
    : DEFAULT_HISTORY_LIMIT;
}

function errorDetails(error: unknown, operation: GitOperationKey): GitWorkspaceError {
  if (error instanceof GitApiError) {
    return { operation, code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { operation, code: "GIT_FAILED", message: error.message };
  }
  return { operation, code: "GIT_FAILED", message: "The Git operation could not be completed." };
}

export function useGitWorkspace(
  workspaceId: string | null,
  intent: GitWorkspaceIntent = {},
) {
  const wantsBranches = intent.branches === true;
  const wantsHistory = intent.history === true;
  const historyLimit = normalizedHistoryLimit(intent.historyLimit);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [history, setHistory] = useState<GitLog | null>(null);
  const [conflicts, setConflicts] = useState<GitConflicts | null>(null);
  const [busy, setBusy] = useState<Set<GitOperationKey>>(() => new Set());
  const [error, setError] = useState<GitWorkspaceError | null>(null);
  const [notRepository, setNotRepository] = useState(false);

  const identityRef = useRef<WorkspaceIdentity>({ workspaceId, generation: 0 });
  if (identityRef.current.workspaceId !== workspaceId) {
    identityRef.current = {
      workspaceId,
      generation: identityRef.current.generation + 1,
    };
  }

  const intentRef = useRef({ branches: wantsBranches, history: wantsHistory, historyLimit });
  intentRef.current = { branches: wantsBranches, history: wantsHistory, historyLimit };

  const statusRef = useRef(status);
  const branchesRef = useRef(branches);
  const historyRef = useRef(history);
  const conflictsRef = useRef(conflicts);
  statusRef.current = status;
  branchesRef.current = branches;
  historyRef.current = history;
  conflictsRef.current = conflicts;

  const epochRef = useRef(0);
  const inFlightReadsRef = useRef(new Map<GitReadOperation, InFlightRead>());
  const inFlightMutationsRef = useRef(new Map<GitMutationOperation, InFlightMutation>());
  const busyTokensRef = useRef(new Map<GitOperationKey, Set<symbol>>());
  const changeTimerRef = useRef<number | null>(null);

  const isCurrent = useCallback((identity: WorkspaceIdentity) => identityRef.current === identity, []);

  const beginBusy = useCallback((operation: GitOperationKey) => {
    const token = Symbol(operation);
    const tokens = busyTokensRef.current.get(operation) ?? new Set<symbol>();
    tokens.add(token);
    busyTokensRef.current.set(operation, tokens);
    setBusy((current) => {
      if (current.has(operation)) return current;
      const next = new Set(current);
      next.add(operation);
      return next;
    });
    return token;
  }, []);

  const endBusy = useCallback((operation: GitOperationKey, token: symbol) => {
    const tokens = busyTokensRef.current.get(operation);
    if (!tokens || !tokens.delete(token) || tokens.size > 0) return;
    busyTokensRef.current.delete(operation);
    setBusy((current) => {
      if (!current.has(operation)) return current;
      const next = new Set(current);
      next.delete(operation);
      return next;
    });
  }, []);

  const applyStatus = useCallback((nextStatus: GitStatus | null) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const applyBranches = useCallback((nextBranches: GitBranches | null) => {
    branchesRef.current = nextBranches;
    setBranches(nextBranches);
  }, []);

  const applyHistory = useCallback((nextHistory: GitLog | null) => {
    historyRef.current = nextHistory;
    setHistory(nextHistory);
  }, []);

  const applyConflicts = useCallback((nextConflicts: GitConflicts | null) => {
    conflictsRef.current = nextConflicts;
    setConflicts(nextConflicts);
  }, []);

  const recordError = useCallback((caught: unknown, operation: GitOperationKey, identity: WorkspaceIdentity) => {
    if (!isCurrent(identity)) return;
    const nextError = errorDetails(caught, operation);
    setError(nextError);
    if (nextError.code === "NOT_A_REPOSITORY") {
      setNotRepository(true);
      applyStatus(null);
      applyBranches(null);
      applyHistory(null);
      applyConflicts(null);
    }
  }, [applyBranches, applyConflicts, applyHistory, applyStatus, isCurrent]);

  const clearOperationError = useCallback((operation: GitOperationKey) => {
    setError((current) => current?.operation === operation ? null : current);
  }, []);

  const invalidateReads = useCallback(() => {
    epochRef.current += 1;
    inFlightReadsRef.current.clear();
  }, []);

  const runRead = useCallback(<T,>(
    operation: GitReadOperation,
    load: (workspaceId: string) => Promise<T>,
    apply: (value: T) => void,
  ): Promise<T | null> => {
    const identity = identityRef.current;
    if (!identity.workspaceId) return Promise.resolve(null);
    const epoch = epochRef.current;
    const existing = inFlightReadsRef.current.get(operation);
    if (existing && existing.identity === identity && existing.epoch === epoch) {
      return existing.promise as Promise<T | null>;
    }

    const token = beginBusy(operation);
    let entry: InFlightRead | undefined;
    const promise = (async () => {
      try {
        const value = await load(identity.workspaceId!);
        if (!isCurrent(identity) || epochRef.current !== epoch) return null;
        apply(value);
        setNotRepository(false);
        clearOperationError(operation);
        return value;
      } catch (caught) {
        if (isCurrent(identity) && epochRef.current === epoch) {
          recordError(caught, operation, identity);
        }
        return null;
      } finally {
        if (entry && inFlightReadsRef.current.get(operation) === entry) {
          inFlightReadsRef.current.delete(operation);
        }
        endBusy(operation, token);
      }
    })();
    entry = { identity, epoch, promise };
    inFlightReadsRef.current.set(operation, entry);
    return promise;
  }, [beginBusy, clearOperationError, endBusy, isCurrent, recordError]);

  const refreshStatus = useCallback(() => runRead(
    "status",
    (targetWorkspaceId) => gitApi.status({ workspaceId: targetWorkspaceId }),
    applyStatus,
  ), [applyStatus, runRead]);

  const refreshBranches = useCallback(() => runRead(
    "branches",
    (targetWorkspaceId) => gitApi.branches({ workspaceId: targetWorkspaceId }),
    applyBranches,
  ), [applyBranches, runRead]);

  const refreshHistory = useCallback((options: GitHistoryOptions = {}) => {
    const maxCount = normalizedHistoryLimit(options.maxCount ?? intentRef.current.historyLimit);
    const skip = Number.isInteger(options.skip) && options.skip !== undefined && options.skip >= 0
      ? options.skip
      : 0;
    return runRead(
      "history",
      (targetWorkspaceId) => gitApi.log({ workspaceId: targetWorkspaceId, maxCount, skip }),
      applyHistory,
    );
  }, [applyHistory, runRead]);

  const refreshConflicts = useCallback(() => runRead(
    "conflicts",
    (targetWorkspaceId) => gitApi.conflicts({ workspaceId: targetWorkspaceId }),
    applyConflicts,
  ), [applyConflicts, runRead]);

  const refreshLazyViews = useCallback(async () => {
    const requests: Array<Promise<unknown>> = [];
    if (intentRef.current.branches || branchesRef.current !== null) requests.push(refreshBranches());
    if (intentRef.current.history || historyRef.current !== null) requests.push(refreshHistory());
    if (conflictsRef.current !== null) requests.push(refreshConflicts());
    await Promise.all(requests);
  }, [refreshBranches, refreshConflicts, refreshHistory]);

  const runMutation = useCallback(<T,>(
    operation: GitMutationOperation,
    mutate: (workspaceId: string) => Promise<T>,
    resultStatus: (result: T) => GitStatus | null,
  ): Promise<T | null> => {
    const identity = identityRef.current;
    if (!identity.workspaceId) return Promise.resolve(null);
    const existing = inFlightMutationsRef.current.get(operation);
    if (existing && existing.identity === identity) return existing.promise as Promise<T | null>;

    const token = beginBusy(operation);
    let entry: InFlightMutation | undefined;
    const promise = (async () => {
      try {
        const result = await mutate(identity.workspaceId!);
        if (!isCurrent(identity)) return null;

        invalidateReads();
        const nextStatus = resultStatus(result);
        if (nextStatus) applyStatus(nextStatus);
        else void refreshStatus();
        if (nextStatus && conflictsRef.current !== null) {
          const nextConflictFiles = nextStatus.files.filter((file) => file.conflict);
          applyConflicts({
            branch: nextStatus.branch,
            conflicts: nextConflictFiles,
            count: nextConflictFiles.length,
          });
        }
        setNotRepository(false);
        const refreshError = (result as { refreshError?: { code: string; message: string } | null }).refreshError;
        if (refreshError) setError({ operation, ...refreshError });
        else clearOperationError(operation);
        await refreshLazyViews();
        return isCurrent(identity) ? result : null;
      } catch (caught) {
        recordError(caught, operation, identity);
        return null;
      } finally {
        if (entry && inFlightMutationsRef.current.get(operation) === entry) {
          inFlightMutationsRef.current.delete(operation);
        }
        endBusy(operation, token);
      }
    })();
    entry = { identity, promise };
    inFlightMutationsRef.current.set(operation, entry);
    return promise;
  }, [
    applyConflicts,
    applyStatus,
    beginBusy,
    clearOperationError,
    endBusy,
    invalidateReads,
    isCurrent,
    recordError,
    refreshLazyViews,
    refreshStatus,
  ]);

  const runTransient = useCallback(async <T,>(
    operation: GitOperationKey,
    action: (workspaceId: string) => Promise<T>,
  ): Promise<T | null> => {
    const identity = identityRef.current;
    if (!identity.workspaceId) return null;
    const token = beginBusy(operation);
    try {
      const result = await action(identity.workspaceId);
      if (!isCurrent(identity)) return null;
      setNotRepository(false);
      clearOperationError(operation);
      return result;
    } catch (caught) {
      recordError(caught, operation, identity);
      return null;
    } finally {
      endBusy(operation, token);
    }
  }, [beginBusy, clearOperationError, endBusy, isCurrent, recordError]);

  const getDiff = useCallback((selection: GitDiffSelection): Promise<GitFileDiff | null> => {
    return runTransient("diff", (targetWorkspaceId) => {
      const request = { workspaceId: targetWorkspaceId, ...selection } as GitDiffRequest;
      return gitApi.diff(request);
    });
  }, [runTransient]);

  const stage = useCallback((paths: string[]): Promise<GitStageResult | null> => runMutation(
    "stage",
    (targetWorkspaceId) => gitApi.stage({ workspaceId: targetWorkspaceId, paths }),
    (result) => result.status,
  ), [runMutation]);

  const unstage = useCallback((paths: string[]): Promise<GitStageResult | null> => runMutation(
    "unstage",
    (targetWorkspaceId) => gitApi.unstage({ workspaceId: targetWorkspaceId, paths }),
    (result) => result.status,
  ), [runMutation]);

  const commit = useCallback((message: string): Promise<GitCommitResult | null> => runMutation(
    "commit",
    (targetWorkspaceId) => gitApi.commit({ workspaceId: targetWorkspaceId, message }),
    (result) => result.status,
  ), [runMutation]);

  const checkoutBranch = useCallback((name: string): Promise<GitBranchMutationResult | null> => runMutation(
    "checkout-branch",
    (targetWorkspaceId) => gitApi.checkoutBranch({ workspaceId: targetWorkspaceId, name }),
    (result) => result.status,
  ), [runMutation]);

  const createBranch = useCallback((name: string): Promise<GitBranchMutationResult | null> => runMutation(
    "create-branch",
    (targetWorkspaceId) => gitApi.createBranch({ workspaceId: targetWorkspaceId, name }),
    (result) => result.status,
  ), [runMutation]);

  useEffect(() => {
    const identity = identityRef.current;
    if (changeTimerRef.current !== null) {
      window.clearTimeout(changeTimerRef.current);
      changeTimerRef.current = null;
    }
    invalidateReads();
    inFlightMutationsRef.current.clear();
    busyTokensRef.current.clear();
    setBusy(new Set());
    applyStatus(null);
    applyBranches(null);
    applyHistory(null);
    applyConflicts(null);
    setError(null);
    setNotRepository(false);
    if (identity.workspaceId) void refreshStatus();
  }, [
    applyBranches,
    applyConflicts,
    applyHistory,
    applyStatus,
    invalidateReads,
    refreshStatus,
    workspaceId,
  ]);

  useEffect(() => {
    if (workspaceId && wantsBranches) void refreshBranches();
  }, [refreshBranches, wantsBranches, workspaceId]);

  useEffect(() => {
    if (workspaceId && wantsHistory) void refreshHistory({ maxCount: historyLimit });
  }, [historyLimit, refreshHistory, wantsHistory, workspaceId]);

  useEffect(() => gitApi.onDidChange((event) => {
    const identity = identityRef.current;
    if (!identity.workspaceId || event.workspaceId !== identity.workspaceId) return;
    if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
    changeTimerRef.current = window.setTimeout(() => {
      changeTimerRef.current = null;
      if (!isCurrent(identity)) return;
      invalidateReads();
      void refreshStatus();
      void refreshLazyViews();
    }, CHANGE_DEBOUNCE_MS);
  }), [invalidateReads, isCurrent, refreshLazyViews, refreshStatus]);

  useEffect(() => () => {
    if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
  }, []);

  const loading = useMemo(() => ({
    status: busy.has("status"),
    branches: busy.has("branches"),
    history: busy.has("history"),
    conflicts: busy.has("conflicts"),
  }), [busy]);

  const dismissError = useCallback(() => setError(null), []);

  return {
    source: gitApi.source,
    status,
    branches,
    history,
    conflicts,
    loading,
    busy: busy as ReadonlySet<GitOperationKey>,
    error,
    notRepository,
    refreshStatus,
    refreshBranches,
    refreshHistory,
    refreshConflicts,
    getDiff,
    stage,
    unstage,
    commit,
    checkoutBranch,
    createBranch,
    dismissError,
  };
}

export type GitWorkspaceController = ReturnType<typeof useGitWorkspace>;
