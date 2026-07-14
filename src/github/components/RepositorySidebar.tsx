import { useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  CircleOff,
  Copy,
  ExternalLink,
  GitFork,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  Unplug,
  WifiOff,
  X,
} from "lucide-react";
import type { GitHubWorkspaceController } from "../useGitHubWorkspace";
import type { GitHubIssueSummary, GitHubPullRequestSummary, GitHubWorkspaceState } from "../types";
import { IssueList } from "./IssueList";
import { PullRequestList } from "./PullRequestList";

const revealTransition = { type: "tween" as const, duration: 0.12 };

export type GitHubRepositoryView = "pull-requests" | "issues" | "branches";

export interface RepositorySidebarProps {
  repositoryName: string;
  activeView: GitHubRepositoryView;
  onActiveViewChange: (view: GitHubRepositoryView) => void;
  github: GitHubWorkspaceController;
  branchesView: ReactNode;
  selectedPullRequestNumber?: number | null;
  selectedIssueNumber?: number | null;
  branchQuery?: string;
  onBranchQueryChange?: (query: string) => void;
  onRefreshBranches?: () => void | Promise<void>;
  onSelectPullRequest: (pullRequest: GitHubPullRequestSummary) => void;
  onSelectIssue: (issue: GitHubIssueSummary) => void;
  onConfigureRemote?: () => void;
  onOpenConfiguration?: () => void;
}

function safeOpen(url: string | null) {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return;
    window.open(parsed.toString(), "_blank", "noopener,noreferrer");
  } catch {
    // Invalid URLs supplied by the bridge are intentionally ignored.
  }
}

function statusLabel(state: GitHubWorkspaceState | null): string {
  if (!state) return "Checking GitHub";
  switch (state.status) {
    case "connected": return state.account ? `Connected as ${state.account.login}` : "GitHub connected";
    case "connecting": return "Waiting for authorization";
    case "offline": return "Offline";
    case "expired": return "Connection expired";
    case "not-installed": return "Repository access needed";
    case "no-remote": return "No GitHub remote";
    case "config-required": return "Setup required";
    case "disconnected": return "GitHub disconnected";
    case "error": return "GitHub unavailable";
    default: return "Checking GitHub";
  }
}

function ConnectionEmpty({
  icon: Icon,
  title,
  body,
  actionLabel,
  busy = false,
  onAction,
}: {
  icon: typeof GitFork;
  title: string;
  body: string;
  actionLabel?: string;
  busy?: boolean;
  onAction?: () => void;
}) {
  return (
    <motion.div className="github-connection-empty" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={revealTransition}>
      <Icon aria-hidden="true" />
      <strong>{title}</strong>
      <p>{body}</p>
      {actionLabel && onAction ? (
        <button type="button" disabled={busy} onClick={onAction}>
          {busy ? <LoaderCircle className="git-spin" aria-hidden="true" /> : null}
          {actionLabel}
        </button>
      ) : null}
    </motion.div>
  );
}

function DeviceFlowState({ github }: { github: GitHubWorkspaceController }) {
  const [copied, setCopied] = useState(false);
  const flow = github.deviceFlow;
  if (!flow) {
    return (
      <motion.div className="github-connection-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={revealTransition}>
        <LoaderCircle className="git-spin" aria-hidden="true" />
        <strong>Waiting for GitHub</strong>
        <p>Preparing a secure authorization code…</p>
        <button type="button" onClick={() => void github.cancelDeviceFlow()}>Cancel</button>
      </motion.div>
    );
  }

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <motion.div className="github-device-flow" role="status" initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={revealTransition}>
      <GitFork aria-hidden="true" />
      <strong>Connect GitHub</strong>
      <p>Enter this one-time code on GitHub. This window will update automatically.</p>
      <div className="github-device-code">
        <code>{flow.userCode}</code>
        <button type="button" aria-label={copied ? "GitHub code copied" : "Copy GitHub code"} onClick={() => void copyCode()}>
          <AnimatePresence initial={false} mode="wait">
            <motion.span key={copied ? "copied" : "copy"} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={revealTransition}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </motion.span>
          </AnimatePresence>
        </button>
      </div>
      <div className="github-device-actions">
        <button className="is-primary" type="button" onClick={() => void github.openDeviceFlow()}>
          <ExternalLink aria-hidden="true" />Open GitHub
        </button>
        <button type="button" onClick={() => void github.cancelDeviceFlow()}>Cancel</button>
      </div>
      {github.errors["open-device-flow"] || github.errors["poll-device-flow"] ? (
        <small>{github.errors["open-device-flow"]?.message ?? github.errors["poll-device-flow"]?.message}</small>
      ) : null}
    </motion.div>
  );
}

function RepositoryConnectionGate({
  github,
  hasCachedItems,
  onConfigureRemote,
  onOpenConfiguration,
  children,
}: {
  github: GitHubWorkspaceController;
  hasCachedItems: boolean;
  onConfigureRemote?: () => void;
  onOpenConfiguration?: () => void;
  children: ReactNode;
}) {
  const state = github.workspaceState;
  if (!state || state.status === "checking") {
    return (
      <motion.div className="github-list-loading" role="status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={revealTransition}>
        <LoaderCircle className="git-spin" aria-hidden="true" />
        <span>Checking GitHub…</span>
      </motion.div>
    );
  }

  if (github.deviceFlow) return <DeviceFlowState github={github} />;

  if (state.status === "no-remote") {
    return (
      <ConnectionEmpty
        icon={GitFork}
        title="No GitHub remote"
        body={state.message ?? "Add a GitHub remote to this repository before connecting."}
        actionLabel={onConfigureRemote ? "Configure Remote" : "Check Again"}
        busy={github.loading.state}
        onAction={onConfigureRemote ?? (() => void github.refreshState())}
      />
    );
  }

  if (state.status === "config-required") {
    return (
      <ConnectionEmpty
        icon={ShieldAlert}
        title="GitHub setup required"
        body={state.message ?? "Configure the GitHub App before teammates can connect."}
        actionLabel={onOpenConfiguration ? "Open Settings" : "Check Again"}
        busy={github.loading.state}
        onAction={onOpenConfiguration ?? (() => void github.refreshState())}
      />
    );
  }

  if (state.status === "disconnected") {
    return (
      <ConnectionEmpty
        icon={GitFork}
        title="Connect GitHub"
        body="Browse pull requests, issues, and review feedback for this repository."
        actionLabel="Connect GitHub"
        busy={github.busy.has("begin-device-flow")}
        onAction={() => void github.beginDeviceFlow()}
      />
    );
  }

  if (state.status === "connecting") return <DeviceFlowState github={github} />;

  if (state.status === "not-installed") {
    return (
      <ConnectionEmpty
        icon={ShieldAlert}
        title="Repository access needed"
        body={state.message ?? "Install the GitHub App for this repository to continue."}
        actionLabel={state.installationUrl ? "Install GitHub App" : "Check Again"}
        busy={github.loading.state}
        onAction={() => state.installationUrl ? safeOpen(state.installationUrl) : void github.refreshState()}
      />
    );
  }

  if (state.status === "expired") {
    return (
      <ConnectionEmpty
        icon={Unplug}
        title="GitHub connection expired"
        body={state.message ?? "Reconnect your GitHub account to continue."}
        actionLabel="Reconnect"
        busy={github.busy.has("begin-device-flow")}
        onAction={() => void github.beginDeviceFlow()}
      />
    );
  }

  if (state.status === "offline" && !hasCachedItems) {
    return (
      <ConnectionEmpty
        icon={WifiOff}
        title="GitHub is offline"
        body={state.message ?? "Reconnect to load pull requests and issues."}
        actionLabel="Try Again"
        busy={github.loading.state}
        onAction={() => void github.refreshState()}
      />
    );
  }

  if (state.status === "error" && !hasCachedItems) {
    return (
      <ConnectionEmpty
        icon={CircleOff}
        title="GitHub is unavailable"
        body={state.message ?? "The repository connection could not be loaded."}
        actionLabel="Try Again"
        busy={github.loading.state}
        onAction={() => void github.refreshState()}
      />
    );
  }

  return <>{children}</>;
}

export function RepositorySidebar({
  repositoryName,
  activeView,
  onActiveViewChange,
  github,
  branchesView,
  selectedPullRequestNumber = null,
  selectedIssueNumber = null,
  branchQuery = "",
  onBranchQueryChange,
  onRefreshBranches,
  onSelectPullRequest,
  onSelectIssue,
  onConfigureRemote,
  onOpenConfiguration,
}: RepositorySidebarProps) {
  const [remoteQuery, setRemoteQuery] = useState("");
  const query = activeView === "branches" ? branchQuery : remoteQuery;
  const state = github.workspaceState;
  const pullRequests = github.pullRequests?.items ?? [];
  const issues = github.issues?.items ?? [];

  const filteredPullRequests = useMemo(() => {
    const normalized = remoteQuery.trim().toLocaleLowerCase();
    if (!normalized) return pullRequests;
    return pullRequests.filter((item) => (
      item.title.toLocaleLowerCase().includes(normalized) ||
      (item.author?.login.toLocaleLowerCase().includes(normalized) ?? false) ||
      String(item.number).includes(normalized) ||
      item.labels.some((label) => label.name.toLocaleLowerCase().includes(normalized))
    ));
  }, [pullRequests, remoteQuery]);

  const filteredIssues = useMemo(() => {
    const normalized = remoteQuery.trim().toLocaleLowerCase();
    if (!normalized) return issues;
    return issues.filter((item) => (
      item.title.toLocaleLowerCase().includes(normalized) ||
      (item.author?.login.toLocaleLowerCase().includes(normalized) ?? false) ||
      String(item.number).includes(normalized) ||
      item.labels.some((label) => label.name.toLocaleLowerCase().includes(normalized))
    ));
  }, [issues, remoteQuery]);

  const refresh = () => {
    if (activeView === "pull-requests") return void github.refreshPullRequests();
    if (activeView === "issues") return void github.refreshIssues();
    return void onRefreshBranches?.();
  };

  const activeError = activeView === "pull-requests"
    ? github.errors["pull-requests"]
    : activeView === "issues"
      ? github.errors.issues
      : null;
  const activeResult = activeView === "pull-requests" ? github.pullRequests : github.issues;
  const cached = Boolean(activeResult?.cached || activeResult?.stale || state?.status === "offline");
  const hasCachedItems = activeView === "pull-requests"
    ? pullRequests.length > 0
    : activeView === "issues"
      ? issues.length > 0
      : false;
  const repositoryLabel = state?.repository?.fullName ?? repositoryName;

  return (
    <aside className="sidebar panel-surface github-repository-sidebar" aria-label="Branches, pull requests, and issues">
      <label className="search-field github-search-field">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => {
            if (activeView === "branches") onBranchQueryChange?.(event.target.value);
            else setRemoteQuery(event.target.value);
          }}
          placeholder={activeView === "pull-requests" ? "Search pull requests" : activeView === "issues" ? "Search issues" : "Filter branches"}
          aria-label={activeView === "pull-requests" ? "Search pull requests" : activeView === "issues" ? "Search issues" : "Filter branches"}
          disabled={activeView === "branches" && !onBranchQueryChange}
        />
        <button
          type="button"
          className="sidebar-menu-trigger"
          aria-label={`Refresh ${activeView}`}
          title="Refresh"
          disabled={activeView === "branches" ? !onRefreshBranches : github.loading.pullRequests || github.loading.issues}
          onClick={refresh}
        >
          <RefreshCw className={(activeView === "pull-requests" && github.loading.pullRequests) || (activeView === "issues" && github.loading.issues) ? "git-spin" : ""} aria-hidden="true" />
        </button>
      </label>

      <div className="git-repository-row github-repository-row">
        <GitFork aria-hidden="true" />
        <div>
          <strong>{repositoryLabel}</strong>
          <span>{statusLabel(state)}</span>
        </div>
        <span className={`github-connection-mark is-${state?.status ?? "checking"}`} title={statusLabel(state)}>
          <GitFork aria-hidden="true" />
        </span>
      </div>

      <div className="github-view-tabs" role="tablist" aria-label="Repository views">
        {([
          ["pull-requests", "Pull Requests"],
          ["issues", "Issues"],
          ["branches", "Branches"],
        ] as const).map(([id, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeView === id}
            aria-controls="github-repository-view-panel"
            id={`github-repository-tab-${id}`}
            className={activeView === id ? "is-active" : ""}
            key={id}
            onClick={() => onActiveViewChange(id)}
          >
            {label}
            {activeView === id ? <motion.span className="github-tab-indicator" layoutId="github-repository-tab-indicator" transition={revealTransition} /> : null}
          </button>
        ))}
      </div>

      <div className="github-sidebar-scroll">
        <AnimatePresence initial={false} mode="wait">
        <motion.div
          className="github-view-panel"
          id="github-repository-view-panel"
          role="tabpanel"
          aria-labelledby={`github-repository-tab-${activeView}`}
          key={activeView}
          initial={{ opacity: 0, x: 4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -4 }}
          transition={revealTransition}
        >
        {activeView === "branches" ? (
          <div className="github-branches-slot">{branchesView}</div>
        ) : (
          <AnimatePresence initial={false} mode="wait">
          <motion.div
            className="github-gate-transition"
            key={github.deviceFlow ? "device-flow" : state?.status ?? "checking"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={revealTransition}
          >
          <RepositoryConnectionGate
            github={github}
            hasCachedItems={hasCachedItems}
            onConfigureRemote={onConfigureRemote}
            onOpenConfiguration={onOpenConfiguration}
          >
            <AnimatePresence initial={false} mode="popLayout">
            {cached ? (
              <motion.div className="github-cached-notice" role="status" key="cached" initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={revealTransition}>
                <WifiOff aria-hidden="true" />
                <span>Offline · showing saved results</span>
              </motion.div>
            ) : null}
            </AnimatePresence>
            <AnimatePresence initial={false} mode="popLayout">
            {activeError ? (
              <motion.div className="git-inline-message git-inline-message--error github-list-error" role="status" key="active-error" initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -2 }} transition={revealTransition}>
                <AlertTriangle aria-hidden="true" />
                <span>{activeError.message}</span>
                <button type="button" aria-label="Dismiss GitHub error" onClick={() => github.dismissError(activeError.operation)}>
                  <X aria-hidden="true" />
                </button>
              </motion.div>
            ) : null}
            </AnimatePresence>
            {activeView === "pull-requests" ? (
              <PullRequestList
                items={filteredPullRequests}
                selectedNumber={selectedPullRequestNumber}
                loading={github.loading.pullRequests || !github.pullRequests}
                query={remoteQuery}
                onSelect={onSelectPullRequest}
              />
            ) : (
              <IssueList
                items={filteredIssues}
                selectedNumber={selectedIssueNumber}
                loading={github.loading.issues || !github.issues}
                query={remoteQuery}
                onSelect={onSelectIssue}
              />
            )}
          </RepositoryConnectionGate>
          </motion.div>
          </AnimatePresence>
        )}
        </motion.div>
        </AnimatePresence>
      </div>
      <div className="sidebar-scrollbar" aria-hidden="true"><span /></div>
    </aside>
  );
}
