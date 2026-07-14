import type { RawResult } from "../editor/bridge";

export type GitStatusBranch = {
  current: string | null;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
};

export type GitFileRecordType = "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";

export type GitFileStatus = {
  path: string;
  originalPath: string | null;
  recordType: GitFileRecordType;
  indexStatus: string | null;
  worktreeStatus: string | null;
  staged: boolean;
  modified: boolean;
  untracked: boolean;
  ignored: boolean;
  conflict: boolean;
  submodule: string | null;
};

export type GitStatusCounts = {
  total: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
};

export type GitStatus = {
  branch: GitStatusBranch;
  files: GitFileStatus[];
  counts: GitStatusCounts;
};

export type GitBranch = {
  kind: "local" | "remote";
  name: string;
  ref: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  hash: string;
  date: string | null;
  subject: string;
};

export type GitBranches = {
  current: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  local: GitBranch[];
  remote: GitBranch[];
};

export type GitCommitAuthor = {
  name: string;
  email: string;
};

export type GitCommit = {
  hash: string;
  parents: string[];
  author: GitCommitAuthor;
  date: string;
  subject: string;
};

export type GitLog = {
  commits: GitCommit[];
  maxCount: number;
  skip: number;
  hasMore: boolean;
};

export type GitDiffMode = "working" | "staged" | "commit";

export type GitFileDiff = {
  path: string;
  mode: GitDiffMode;
  commit: string | null;
  patch: string;
};

export type GitRepositorySummary = {
  workspaceId: string;
  repositoryRoot: string;
  head: string | null;
  status: GitStatus;
  branches: GitBranches;
};

export type GitConflicts = {
  branch: GitStatusBranch;
  conflicts: GitFileStatus[];
  count: number;
};

export type GitStageResult = {
  applied: true;
  paths: string[];
  status: GitStatus | null;
  refreshError: { code: string; message: string } | null;
};

export type GitCommitResult = {
  applied: true;
  commit: GitCommit | null;
  status: GitStatus | null;
  refreshError: { code: string; message: string } | null;
};

export type GitBranchMutationResult = {
  applied: true;
  branch: string;
  status: GitStatus | null;
  refreshError: { code: string; message: string } | null;
};

export type GitWorkspaceRequest = { workspaceId: string };
export type GitLogRequest = GitWorkspaceRequest & { maxCount?: number; skip?: number };
export type GitWorkingDiffRequest = GitWorkspaceRequest & { path: string; mode?: "working" };
export type GitStagedDiffRequest = GitWorkspaceRequest & { path: string; mode: "staged" };
export type GitCommitDiffRequest = GitWorkspaceRequest & { path: string; mode: "commit"; commit: string };
export type GitDiffRequest = GitWorkingDiffRequest | GitStagedDiffRequest | GitCommitDiffRequest;
export type GitDiffSelection =
  | { path: string; mode?: "working" }
  | { path: string; mode: "staged" }
  | { path: string; mode: "commit"; commit: string };
export type GitPathsRequest = GitWorkspaceRequest & { paths: string[] };
export type GitCommitRequest = GitWorkspaceRequest & { message: string };
export type GitBranchRequest = GitWorkspaceRequest & { name: string };

export type GitChangeReason = "workspace" | "stage" | "unstage" | "commit" | "checkout" | "create-branch";

export type GitChangeEvent = {
  workspaceId: string;
  reason: GitChangeReason;
  timestamp: number;
};

export interface CollabGitBridge {
  summary(request: GitWorkspaceRequest): Promise<RawResult<GitRepositorySummary>>;
  status(request: GitWorkspaceRequest): Promise<RawResult<GitStatus>>;
  branches(request: GitWorkspaceRequest): Promise<RawResult<GitBranches>>;
  log(request: GitLogRequest): Promise<RawResult<GitLog>>;
  diff(request: GitDiffRequest): Promise<RawResult<GitFileDiff>>;
  stage(request: GitPathsRequest): Promise<RawResult<GitStageResult>>;
  unstage(request: GitPathsRequest): Promise<RawResult<GitStageResult>>;
  commit(request: GitCommitRequest): Promise<RawResult<GitCommitResult>>;
  checkoutBranch(request: GitBranchRequest): Promise<RawResult<GitBranchMutationResult>>;
  createBranch(request: GitBranchRequest): Promise<RawResult<GitBranchMutationResult>>;
  conflicts(request: GitWorkspaceRequest): Promise<RawResult<GitConflicts>>;
  onDidChange(callback: (event: GitChangeEvent) => void): (() => void) | void;
}

export interface GitApi {
  readonly source: "electron" | "demo";
  summary(request: GitWorkspaceRequest): Promise<GitRepositorySummary>;
  status(request: GitWorkspaceRequest): Promise<GitStatus>;
  branches(request: GitWorkspaceRequest): Promise<GitBranches>;
  log(request: GitLogRequest): Promise<GitLog>;
  diff(request: GitDiffRequest): Promise<GitFileDiff>;
  stage(request: GitPathsRequest): Promise<GitStageResult>;
  unstage(request: GitPathsRequest): Promise<GitStageResult>;
  commit(request: GitCommitRequest): Promise<GitCommitResult>;
  checkoutBranch(request: GitBranchRequest): Promise<GitBranchMutationResult>;
  createBranch(request: GitBranchRequest): Promise<GitBranchMutationResult>;
  conflicts(request: GitWorkspaceRequest): Promise<GitConflicts>;
  onDidChange(callback: (event: GitChangeEvent) => void): () => void;
}

declare global {
  interface Window {
    collabGit?: CollabGitBridge;
  }
}
