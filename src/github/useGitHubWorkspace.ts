import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitHubApiError, githubApi } from "./api";
import type {
  GitHubDeviceFlow,
  GitHubIssueDetail,
  GitHubIssueSummary,
  GitHubListResult,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
  GitHubWorkspaceState,
} from "./types";

export type GitHubWorkspaceIntent = {
  pullRequests?: boolean;
  issues?: boolean;
};

export type GitHubOperation =
  | "state"
  | "begin-device-flow"
  | "open-device-flow"
  | "poll-device-flow"
  | "cancel-device-flow"
  | "disconnect"
  | "pull-requests"
  | "issues"
  | "pull-request"
  | "issue";

export type GitHubWorkspaceError = {
  operation: GitHubOperation;
  code: string;
  message: string;
};

type WorkspaceIdentity = {
  workspaceId: string | null;
  generation: number;
};

type InFlightRequest = {
  identity: WorkspaceIdentity;
  epoch: number;
  promise: Promise<unknown>;
};

const CHANGE_DEBOUNCE_MS = 180;
const DEFAULT_POLL_SECONDS = 5;

const OFFLINE_CODES = new Set([
  "OFFLINE",
  "GITHUB_OFFLINE",
  "NETWORK_ERROR",
  "GITHUB_TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETDOWN",
  "ENETUNREACH",
]);

const EXPIRED_CODES = new Set(["AUTH_EXPIRED", "TOKEN_EXPIRED", "BAD_CREDENTIALS"]);

function errorDetails(error: unknown, operation: GitHubOperation): GitHubWorkspaceError {
  if (error instanceof GitHubApiError) {
    return { operation, code: error.code, message: error.message };
  }
  if (error instanceof Error && error.message) {
    return { operation, code: "GITHUB_FAILED", message: error.message };
  }
  return { operation, code: "GITHUB_FAILED", message: "The GitHub operation could not be completed." };
}

function minimumPollSeconds(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_POLL_SECONDS;
  return Math.max(1, Math.ceil(value ?? DEFAULT_POLL_SECONDS));
}

function fallbackState(
  workspaceId: string,
  status: GitHubWorkspaceState["status"],
  message: string,
): GitHubWorkspaceState {
  return {
    workspaceId,
    status,
    repository: null,
    account: null,
    message,
    installationUrl: null,
    lastSyncedAt: null,
    hasCachedData: false,
  };
}

export function useGitHubWorkspace(
  workspaceId: string | null,
  intent: GitHubWorkspaceIntent = {},
) {
  const wantsPullRequests = intent.pullRequests === true;
  const wantsIssues = intent.issues === true;

  const [workspaceState, setWorkspaceState] = useState<GitHubWorkspaceState | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceFlow | null>(null);
  const [pullRequests, setPullRequests] = useState<GitHubListResult<GitHubPullRequestSummary> | null>(null);
  const [issues, setIssues] = useState<GitHubListResult<GitHubIssueSummary> | null>(null);
  const [pullRequest, setPullRequest] = useState<GitHubPullRequestDetail | null>(null);
  const [issue, setIssue] = useState<GitHubIssueDetail | null>(null);
  const [busy, setBusy] = useState<Set<GitHubOperation>>(() => new Set());
  const [errors, setErrors] = useState<Partial<Record<GitHubOperation, GitHubWorkspaceError>>>({});

  const identityRef = useRef<WorkspaceIdentity>({ workspaceId, generation: 0 });
  if (identityRef.current.workspaceId !== workspaceId) {
    identityRef.current = {
      workspaceId,
      generation: identityRef.current.generation + 1,
    };
  }

  const intentRef = useRef({ pullRequests: wantsPullRequests, issues: wantsIssues });
  intentRef.current = { pullRequests: wantsPullRequests, issues: wantsIssues };

  const workspaceStateRef = useRef(workspaceState);
  const deviceFlowRef = useRef(deviceFlow);
  const pullRequestsRef = useRef(pullRequests);
  const issuesRef = useRef(issues);
  const pullRequestRef = useRef(pullRequest);
  const issueRef = useRef(issue);
  workspaceStateRef.current = workspaceState;
  deviceFlowRef.current = deviceFlow;
  pullRequestsRef.current = pullRequests;
  issuesRef.current = issues;
  pullRequestRef.current = pullRequest;
  issueRef.current = issue;

  const selectedPullRequestRef = useRef<number | null>(null);
  const selectedIssueRef = useRef<number | null>(null);
  const epochRef = useRef(0);
  const inFlightReadsRef = useRef(new Map<string, InFlightRequest>());
  const inFlightActionsRef = useRef(new Map<GitHubOperation, InFlightRequest>());
  const busyTokensRef = useRef(new Map<GitHubOperation, Set<symbol>>());
  const changeTimerRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const pollMetaRef = useRef<{ flowId: string | null; lastPollAt: number }>({
    flowId: null,
    lastPollAt: 0,
  });

  const isCurrent = useCallback((identity: WorkspaceIdentity) => identityRef.current === identity, []);

  const beginBusy = useCallback((operation: GitHubOperation) => {
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

  const endBusy = useCallback((operation: GitHubOperation, token: symbol) => {
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

  const clearError = useCallback((operation: GitHubOperation) => {
    setErrors((current) => {
      if (!current[operation]) return current;
      const next = { ...current };
      delete next[operation];
      return next;
    });
  }, []);

  const markCachedListsStale = useCallback(() => {
    setPullRequests((current) => current ? { ...current, cached: true, stale: true } : current);
    setIssues((current) => current ? { ...current, cached: true, stale: true } : current);
  }, []);

  const recordError = useCallback((caught: unknown, operation: GitHubOperation, identity: WorkspaceIdentity) => {
    if (!isCurrent(identity) || !identity.workspaceId) return;
    const nextError = errorDetails(caught, operation);
    setErrors((current) => ({ ...current, [operation]: nextError }));

    if (OFFLINE_CODES.has(nextError.code)) {
      markCachedListsStale();
      setWorkspaceState((current) => ({
        ...(current ?? fallbackState(identity.workspaceId!, "offline", nextError.message)),
        status: "offline",
        message: nextError.message,
        hasCachedData: Boolean(pullRequestsRef.current || issuesRef.current || current?.hasCachedData),
      }));
      return;
    }

    if (EXPIRED_CODES.has(nextError.code)) {
      setWorkspaceState((current) => ({
        ...(current ?? fallbackState(identity.workspaceId!, "expired", nextError.message)),
        status: "expired",
        message: nextError.message,
      }));
      return;
    }

    if (nextError.code === "CONFIG_REQUIRED" || nextError.code === "GITHUB_NOT_CONFIGURED") {
      setWorkspaceState((current) => ({
        ...(current ?? fallbackState(identity.workspaceId!, "config-required", nextError.message)),
        status: "config-required",
        message: nextError.message,
      }));
      return;
    }

    if ([
      "NO_GITHUB_REMOTE",
      "GITHUB_REMOTE_REQUIRED",
      "NOT_A_REPOSITORY",
      "AMBIGUOUS_GITHUB_REMOTE",
    ].includes(nextError.code)) {
      setWorkspaceState((current) => ({
        ...(current ?? fallbackState(identity.workspaceId!, "no-remote", nextError.message)),
        status: "no-remote",
        message: nextError.message,
      }));
      return;
    }

    if (nextError.code === "INSTALLATION_REQUIRED") {
      setWorkspaceState((current) => ({
        ...(current ?? fallbackState(identity.workspaceId!, "not-installed", nextError.message)),
        status: "not-installed",
        message: nextError.message,
      }));
      return;
    }

    if (nextError.code === "GITHUB_DEVICE_FLOW_EXPIRED") {
      deviceFlowRef.current = null;
      setDeviceFlow(null);
      setWorkspaceState((current) => ({
        ...(current ?? fallbackState(identity.workspaceId!, "expired", nextError.message)),
        status: "expired",
        message: nextError.message,
      }));
      return;
    }

    if (operation === "state" && !workspaceStateRef.current) {
      setWorkspaceState(fallbackState(identity.workspaceId, "error", nextError.message));
    }
  }, [isCurrent, markCachedListsStale]);

  const invalidateReads = useCallback(() => {
    epochRef.current += 1;
    inFlightReadsRef.current.clear();
  }, []);

  const runRead = useCallback(<T,>(
    key: string,
    operation: GitHubOperation,
    load: (workspaceId: string) => Promise<T>,
    apply: (value: T) => void,
  ): Promise<T | null> => {
    const identity = identityRef.current;
    if (!identity.workspaceId) return Promise.resolve(null);
    const epoch = epochRef.current;
    const existing = inFlightReadsRef.current.get(key);
    if (existing && existing.identity === identity && existing.epoch === epoch) {
      return existing.promise as Promise<T | null>;
    }

    const token = beginBusy(operation);
    let entry: InFlightRequest | undefined;
    const promise = (async () => {
      try {
        const value = await load(identity.workspaceId!);
        if (!isCurrent(identity) || epochRef.current !== epoch) return null;
        apply(value);
        clearError(operation);
        return value;
      } catch (caught) {
        if (isCurrent(identity) && epochRef.current === epoch) recordError(caught, operation, identity);
        return null;
      } finally {
        if (entry && inFlightReadsRef.current.get(key) === entry) inFlightReadsRef.current.delete(key);
        endBusy(operation, token);
      }
    })();
    entry = { identity, epoch, promise };
    inFlightReadsRef.current.set(key, entry);
    return promise;
  }, [beginBusy, clearError, endBusy, isCurrent, recordError]);

  const runAction = useCallback(<T,>(
    operation: GitHubOperation,
    action: (workspaceId: string) => Promise<T>,
  ): Promise<T | null> => {
    const identity = identityRef.current;
    if (!identity.workspaceId) return Promise.resolve(null);
    const existing = inFlightActionsRef.current.get(operation);
    if (existing && existing.identity === identity) return existing.promise as Promise<T | null>;

    const token = beginBusy(operation);
    let entry: InFlightRequest | undefined;
    const promise = (async () => {
      try {
        const value = await action(identity.workspaceId!);
        if (!isCurrent(identity)) return null;
        clearError(operation);
        return value;
      } catch (caught) {
        recordError(caught, operation, identity);
        return null;
      } finally {
        if (entry && inFlightActionsRef.current.get(operation) === entry) {
          inFlightActionsRef.current.delete(operation);
        }
        endBusy(operation, token);
      }
    })();
    entry = { identity, epoch: epochRef.current, promise };
    inFlightActionsRef.current.set(operation, entry);
    return promise;
  }, [beginBusy, clearError, endBusy, isCurrent, recordError]);

  const refreshState = useCallback(() => runRead(
    "state",
    "state",
    (targetWorkspaceId) => githubApi.state({ workspaceId: targetWorkspaceId }),
    (value) => {
      const effectiveValue = deviceFlowRef.current && value.status === "disconnected"
        ? { ...value, status: "connecting" as const, message: "Waiting for GitHub authorization." }
        : value;
      workspaceStateRef.current = effectiveValue;
      setWorkspaceState(effectiveValue);
      if (!deviceFlowRef.current && value.status !== "connecting") {
        deviceFlowRef.current = null;
        setDeviceFlow(null);
      }
    },
  ), [runRead]);

  const refreshPullRequests = useCallback(() => runRead(
    "pull-requests",
    "pull-requests",
    (targetWorkspaceId) => githubApi.listPullRequests({ workspaceId: targetWorkspaceId }),
    (value) => {
      pullRequestsRef.current = value;
      setPullRequests(value);
    },
  ), [runRead]);

  const refreshIssues = useCallback(() => runRead(
    "issues",
    "issues",
    (targetWorkspaceId) => githubApi.listIssues({ workspaceId: targetWorkspaceId }),
    (value) => {
      issuesRef.current = value;
      setIssues(value);
    },
  ), [runRead]);

  const loadPullRequest = useCallback((number: number) => {
    if (!Number.isInteger(number) || number < 1) return Promise.resolve(null);
    selectedPullRequestRef.current = number;
    setPullRequest((current) => current?.number === number ? current : null);
    return runRead(
      `pull-request:${number}`,
      "pull-request",
      (targetWorkspaceId) => githubApi.getPullRequest({ workspaceId: targetWorkspaceId, number }),
      (value) => {
        if (selectedPullRequestRef.current !== number) return;
        pullRequestRef.current = value;
        setPullRequest(value);
      },
    );
  }, [runRead]);

  const loadIssue = useCallback((number: number) => {
    if (!Number.isInteger(number) || number < 1) return Promise.resolve(null);
    selectedIssueRef.current = number;
    setIssue((current) => current?.number === number ? current : null);
    return runRead(
      `issue:${number}`,
      "issue",
      (targetWorkspaceId) => githubApi.getIssue({ workspaceId: targetWorkspaceId, number }),
      (value) => {
        if (selectedIssueRef.current !== number) return;
        issueRef.current = value;
        setIssue(value);
      },
    );
  }, [runRead]);

  const clearPullRequest = useCallback(() => {
    selectedPullRequestRef.current = null;
    pullRequestRef.current = null;
    setPullRequest(null);
    clearError("pull-request");
  }, [clearError]);

  const clearIssue = useCallback(() => {
    selectedIssueRef.current = null;
    issueRef.current = null;
    setIssue(null);
    clearError("issue");
  }, [clearError]);

  const openDeviceFlow = useCallback(async (flowId = deviceFlowRef.current?.flowId) => {
    if (!flowId) return null;
    return runAction(
      "open-device-flow",
      (targetWorkspaceId) => githubApi.openDeviceFlow({ workspaceId: targetWorkspaceId, flowId }),
    );
  }, [runAction]);

  const beginDeviceFlow = useCallback(async () => {
    const result = await runAction(
      "begin-device-flow",
      (targetWorkspaceId) => githubApi.beginDeviceFlow({ workspaceId: targetWorkspaceId }),
    );
    if (!result || identityRef.current.workspaceId === null) return null;

    const flow = {
      ...result,
      retryAfterSeconds: minimumPollSeconds(result.retryAfterSeconds),
    };
    deviceFlowRef.current = flow;
    setDeviceFlow(flow);
    pollMetaRef.current = { flowId: flow.flowId, lastPollAt: 0 };
    setWorkspaceState((current) => ({
      ...(current ?? fallbackState(identityRef.current.workspaceId!, "connecting", "Waiting for GitHub authorization.")),
      status: "connecting",
      message: "Waiting for GitHub authorization.",
    }));
    void openDeviceFlow(flow.flowId);
    return flow;
  }, [openDeviceFlow, runAction]);

  const cancelDeviceFlow = useCallback(async () => {
    const flow = deviceFlowRef.current;
    if (!flow) return null;
    deviceFlowRef.current = null;
    setDeviceFlow(null);
    const result = await runAction(
      "cancel-device-flow",
      (targetWorkspaceId) => githubApi.cancelDeviceFlow({ workspaceId: targetWorkspaceId, flowId: flow.flowId }),
    );
    if (result) {
      workspaceStateRef.current = result;
      setWorkspaceState(result);
    }
    return result;
  }, [runAction]);

  const disconnect = useCallback(async () => {
    const result = await runAction(
      "disconnect",
      (targetWorkspaceId) => githubApi.disconnect({ workspaceId: targetWorkspaceId }),
    );
    if (!result) return null;
    deviceFlowRef.current = null;
    pullRequestsRef.current = null;
    issuesRef.current = null;
    pullRequestRef.current = null;
    issueRef.current = null;
    selectedPullRequestRef.current = null;
    selectedIssueRef.current = null;
    setDeviceFlow(null);
    setPullRequests(null);
    setIssues(null);
    setPullRequest(null);
    setIssue(null);
    workspaceStateRef.current = result;
    setWorkspaceState(result);
    invalidateReads();
    return result;
  }, [invalidateReads, runAction]);

  const pollDeviceFlow = useCallback(async (flow: GitHubDeviceFlow) => {
    const result = await runAction(
      "poll-device-flow",
      (targetWorkspaceId) => githubApi.pollDeviceFlow({ workspaceId: targetWorkspaceId, flowId: flow.flowId }),
    );

    if (!result) {
      setDeviceFlow((current) => current?.flowId === flow.flowId ? { ...current } : current);
      return null;
    }
    if (deviceFlowRef.current?.flowId !== flow.flowId) return null;

    if (result.status === "pending" || result.status === "slow-down") {
      const nextFlow = {
        ...flow,
        retryAfterSeconds: Math.max(
          minimumPollSeconds(flow.retryAfterSeconds),
          minimumPollSeconds(result.retryAfterSeconds),
        ),
      };
      deviceFlowRef.current = nextFlow;
      setDeviceFlow(nextFlow);
      return result;
    }

    deviceFlowRef.current = null;
    setDeviceFlow(null);

    if (result.status === "connected") {
      invalidateReads();
      if (result.state) {
        workspaceStateRef.current = result.state;
        setWorkspaceState(result.state);
      } else {
        void refreshState();
      }
      return result;
    }

    const currentWorkspaceId = identityRef.current.workspaceId;
    if (!currentWorkspaceId) return result;
    const status = result.status === "expired" ? "expired" : result.status === "cancelled" ? "disconnected" : "error";
    const message = result.message ?? (
      result.status === "expired"
        ? "The GitHub authorization code expired."
        : result.status === "cancelled"
          ? "GitHub authorization was cancelled."
          : "GitHub authorization could not be completed."
    );
    setWorkspaceState((current) => ({
      ...(current ?? fallbackState(currentWorkspaceId, status, message)),
      status,
      message,
    }));
    return result;
  }, [invalidateReads, refreshState, runAction]);

  const refreshLoadedViews = useCallback(async () => {
    const requests: Array<Promise<unknown>> = [];
    if (intentRef.current.pullRequests || pullRequestsRef.current) requests.push(refreshPullRequests());
    if (intentRef.current.issues || issuesRef.current) requests.push(refreshIssues());
    if (selectedPullRequestRef.current !== null) requests.push(loadPullRequest(selectedPullRequestRef.current));
    if (selectedIssueRef.current !== null) requests.push(loadIssue(selectedIssueRef.current));
    await Promise.all(requests);
  }, [loadIssue, loadPullRequest, refreshIssues, refreshPullRequests]);

  useEffect(() => {
    const identity = identityRef.current;
    if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
    changeTimerRef.current = null;
    pollTimerRef.current = null;
    invalidateReads();
    inFlightActionsRef.current.clear();
    busyTokensRef.current.clear();
    setBusy(new Set());
    setErrors({});
    workspaceStateRef.current = null;
    deviceFlowRef.current = null;
    pullRequestsRef.current = null;
    issuesRef.current = null;
    pullRequestRef.current = null;
    issueRef.current = null;
    selectedPullRequestRef.current = null;
    selectedIssueRef.current = null;
    pollMetaRef.current = { flowId: null, lastPollAt: 0 };
    setWorkspaceState(null);
    setDeviceFlow(null);
    setPullRequests(null);
    setIssues(null);
    setPullRequest(null);
    setIssue(null);
    if (identity.workspaceId) void refreshState();
  }, [invalidateReads, refreshState, workspaceId]);

  useEffect(() => {
    const status = workspaceState?.status;
    if (!workspaceId || !wantsPullRequests || (status !== "connected" && status !== "offline")) return;
    if (!pullRequestsRef.current) void refreshPullRequests();
  }, [refreshPullRequests, wantsPullRequests, workspaceId, workspaceState?.status]);

  useEffect(() => {
    const status = workspaceState?.status;
    if (!workspaceId || !wantsIssues || (status !== "connected" && status !== "offline")) return;
    if (!issuesRef.current) void refreshIssues();
  }, [refreshIssues, wantsIssues, workspaceId, workspaceState?.status]);

  useEffect(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (!deviceFlow) return;

    const expiry = new Date(deviceFlow.expiresAt).getTime();
    if (Number.isFinite(expiry) && expiry <= Date.now()) {
      deviceFlowRef.current = null;
      setDeviceFlow(null);
      setWorkspaceState((current) => current ? {
        ...current,
        status: "expired",
        message: "The GitHub authorization code expired.",
      } : current);
      return;
    }

    if (pollMetaRef.current.flowId !== deviceFlow.flowId) {
      pollMetaRef.current = { flowId: deviceFlow.flowId, lastPollAt: 0 };
    }
    const intervalMs = minimumPollSeconds(deviceFlow.retryAfterSeconds) * 1_000;
    const earliest = pollMetaRef.current.lastPollAt + intervalMs;
    const delay = Math.max(intervalMs, earliest - Date.now());
    const identity = identityRef.current;
    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = null;
      if (!isCurrent(identity) || deviceFlowRef.current?.flowId !== deviceFlow.flowId) return;
      pollMetaRef.current.lastPollAt = Date.now();
      void pollDeviceFlow(deviceFlow);
    }, delay);

    return () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [deviceFlow, isCurrent, pollDeviceFlow]);

  useEffect(() => githubApi.onDidChange((event) => {
    const identity = identityRef.current;
    if (!identity.workspaceId || event.workspaceId !== identity.workspaceId) return;
    if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
    changeTimerRef.current = window.setTimeout(() => {
      changeTimerRef.current = null;
      if (!isCurrent(identity)) return;
      invalidateReads();
      void refreshState();
      if (!deviceFlowRef.current) void refreshLoadedViews();
    }, CHANGE_DEBOUNCE_MS);
  }), [invalidateReads, isCurrent, refreshLoadedViews, refreshState]);

  useEffect(() => () => {
    if (changeTimerRef.current !== null) window.clearTimeout(changeTimerRef.current);
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current);
  }, []);

  const loading = useMemo(() => ({
    state: busy.has("state"),
    connecting: busy.has("begin-device-flow") || busy.has("poll-device-flow"),
    pullRequests: busy.has("pull-requests"),
    issues: busy.has("issues"),
    pullRequest: busy.has("pull-request"),
    issue: busy.has("issue"),
  }), [busy]);

  const dismissError = useCallback((operation?: GitHubOperation) => {
    if (operation) clearError(operation);
    else setErrors({});
  }, [clearError]);

  return {
    source: githubApi.source,
    workspaceState,
    deviceFlow,
    pullRequests,
    issues,
    pullRequest,
    issue,
    loading,
    busy: busy as ReadonlySet<GitHubOperation>,
    errors,
    refreshState,
    refreshPullRequests,
    refreshIssues,
    loadPullRequest,
    loadIssue,
    clearPullRequest,
    clearIssue,
    beginDeviceFlow,
    openDeviceFlow,
    cancelDeviceFlow,
    disconnect,
    dismissError,
  };
}

export type GitHubWorkspaceController = ReturnType<typeof useGitHubWorkspace>;
