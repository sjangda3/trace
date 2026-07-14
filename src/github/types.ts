import type { RawResult } from "../editor/bridge";

export type GitHubConnectionStatus =
  | "checking"
  | "no-remote"
  | "config-required"
  | "disconnected"
  | "connecting"
  | "not-installed"
  | "connected"
  | "offline"
  | "expired"
  | "error";

export type GitHubIdentity = {
  login: string;
  name: string | null;
};

export type GitHubRepository = {
  owner: string;
  name: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  remoteName: string | null;
  headOid: string | null;
  currentBranch: string | null;
};

export type GitHubWorkspaceState = {
  workspaceId: string;
  status: GitHubConnectionStatus;
  repository: GitHubRepository | null;
  account: GitHubIdentity | null;
  message: string | null;
  installationUrl: string | null;
  lastSyncedAt: string | null;
  hasCachedData: boolean;
};

/** Public Device Flow fields only. The device code and access token stay in Electron. */
export type GitHubDeviceFlow = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  retryAfterSeconds: number;
};

export type GitHubDeviceFlowPollResult = {
  status: "pending" | "slow-down" | "connected" | "expired" | "cancelled" | "error";
  retryAfterSeconds: number;
  message: string | null;
  state: GitHubWorkspaceState | null;
};

export type GitHubLabel = {
  id: string;
  name: string;
};

export type GitHubPullRequestState = "open" | "closed" | "merged";
export type GitHubReviewDecision = "approved" | "changes-requested" | "review-required" | null;

export type GitHubPullRequestSummary = {
  id: string;
  number: number;
  title: string;
  state: GitHubPullRequestState;
  draft: boolean;
  author: GitHubIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
  headRefName: string;
  baseRefName: string;
  headOid: string;
  reviewDecision: GitHubReviewDecision;
  reviewRequested: boolean;
  commentCount: number;
  changedFiles: number;
  labels: GitHubLabel[];
};

export type GitHubReviewAnchor = {
  path: string;
  startLine: number;
  endLine: number;
  side: "LEFT" | "RIGHT";
  commitOid: string;
  outdated: boolean;
  diffHunk: string | null;
};

export type GitHubReviewComment = {
  id: string;
  author: GitHubIdentity | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
};

export type GitHubReviewThread = {
  id: string;
  resolved: boolean;
  anchor: GitHubReviewAnchor;
  comments: GitHubReviewComment[];
};

export type GitHubPullRequestFile = {
  path: string;
  previousPath: string | null;
  status: "added" | "changed" | "removed" | "renamed" | "copied";
  additions: number;
  deletions: number;
};

export type GitHubCheck = {
  id: string;
  name: string;
  status: "queued" | "in-progress" | "success" | "failure" | "cancelled" | "neutral";
  url: string | null;
};

export type GitHubPullRequestDetail = GitHubPullRequestSummary & {
  body: string;
  additions: number;
  deletions: number;
  mergeable: "mergeable" | "conflicting" | "unknown";
  reviewers: GitHubIdentity[];
  checks: GitHubCheck[];
  files: GitHubPullRequestFile[];
  reviewThreads: GitHubReviewThread[];
};

export type GitHubIssueState = "open" | "closed";

export type GitHubIssueSummary = {
  id: string;
  number: number;
  title: string;
  state: GitHubIssueState;
  author: GitHubIdentity | null;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
  assignedToViewer: boolean;
  assignees: GitHubIdentity[];
  commentCount: number;
  labels: GitHubLabel[];
};

export type GitHubIssueComment = {
  id: string;
  author: GitHubIdentity | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  url: string;
};

export type GitHubIssueDetail = GitHubIssueSummary & {
  body: string;
  comments: GitHubIssueComment[];
};

export type GitHubListResult<T> = {
  items: T[];
  cached: boolean;
  stale: boolean;
  cachedAt: string | null;
};

export type GitHubWorkspaceRequest = { workspaceId: string };
export type GitHubDeviceFlowRequest = GitHubWorkspaceRequest & { flowId: string };
export type GitHubNumberRequest = GitHubWorkspaceRequest & { number: number };

export type GitHubChangeEvent = {
  workspaceId: string;
  reason: "connection" | "repository" | "pull-requests" | "issues" | "review";
  timestamp: number;
};

export interface CollabGitHubBridge {
  state(request: GitHubWorkspaceRequest): Promise<RawResult<GitHubWorkspaceState>>;
  beginDeviceFlow(request: GitHubWorkspaceRequest): Promise<RawResult<GitHubDeviceFlow>>;
  openDeviceFlow(request: GitHubDeviceFlowRequest): Promise<RawResult<{ opened: true }>>;
  pollDeviceFlow(request: GitHubDeviceFlowRequest): Promise<RawResult<GitHubDeviceFlowPollResult>>;
  cancelDeviceFlow(request: GitHubDeviceFlowRequest): Promise<RawResult<GitHubWorkspaceState>>;
  disconnect(request: GitHubWorkspaceRequest): Promise<RawResult<GitHubWorkspaceState>>;
  listPullRequests(request: GitHubWorkspaceRequest): Promise<RawResult<GitHubListResult<GitHubPullRequestSummary>>>;
  listIssues(request: GitHubWorkspaceRequest): Promise<RawResult<GitHubListResult<GitHubIssueSummary>>>;
  getPullRequest(request: GitHubNumberRequest): Promise<RawResult<GitHubPullRequestDetail>>;
  getIssue(request: GitHubNumberRequest): Promise<RawResult<GitHubIssueDetail>>;
  onDidChange(callback: (event: GitHubChangeEvent) => void): (() => void) | void;
}

export interface GitHubApi {
  readonly source: "electron" | "unavailable";
  state(request: GitHubWorkspaceRequest): Promise<GitHubWorkspaceState>;
  beginDeviceFlow(request: GitHubWorkspaceRequest): Promise<GitHubDeviceFlow>;
  openDeviceFlow(request: GitHubDeviceFlowRequest): Promise<{ opened: true }>;
  pollDeviceFlow(request: GitHubDeviceFlowRequest): Promise<GitHubDeviceFlowPollResult>;
  cancelDeviceFlow(request: GitHubDeviceFlowRequest): Promise<GitHubWorkspaceState>;
  disconnect(request: GitHubWorkspaceRequest): Promise<GitHubWorkspaceState>;
  listPullRequests(request: GitHubWorkspaceRequest): Promise<GitHubListResult<GitHubPullRequestSummary>>;
  listIssues(request: GitHubWorkspaceRequest): Promise<GitHubListResult<GitHubIssueSummary>>;
  getPullRequest(request: GitHubNumberRequest): Promise<GitHubPullRequestDetail>;
  getIssue(request: GitHubNumberRequest): Promise<GitHubIssueDetail>;
  onDidChange(callback: (event: GitHubChangeEvent) => void): () => void;
}

declare global {
  interface Window {
    collabGitHub?: CollabGitHubBridge;
  }
}
