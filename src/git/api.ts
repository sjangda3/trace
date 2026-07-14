import type { RawResult } from "../editor/bridge";
import type {
  CollabGitBridge,
  GitApi,
  GitBranchMutationResult,
  GitBranchRequest,
  GitBranches,
  GitChangeEvent,
  GitCommitRequest,
  GitCommitResult,
  GitConflicts,
  GitDiffRequest,
  GitFileDiff,
  GitLog,
  GitLogRequest,
  GitPathsRequest,
  GitRepositorySummary,
  GitStageResult,
  GitStatus,
  GitWorkspaceRequest,
} from "./types";

export class GitApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GitApiError";
  }
}

function unwrap<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw new GitApiError(result.error.code, result.error.message);
}

class ElectronGitApi implements GitApi {
  readonly source = "electron" as const;

  constructor(private readonly bridge: CollabGitBridge) {}

  async summary(request: GitWorkspaceRequest): Promise<GitRepositorySummary> {
    return unwrap(await this.bridge.summary(request));
  }

  async status(request: GitWorkspaceRequest): Promise<GitStatus> {
    return unwrap(await this.bridge.status(request));
  }

  async branches(request: GitWorkspaceRequest): Promise<GitBranches> {
    return unwrap(await this.bridge.branches(request));
  }

  async log(request: GitLogRequest): Promise<GitLog> {
    return unwrap(await this.bridge.log(request));
  }

  async diff(request: GitDiffRequest): Promise<GitFileDiff> {
    return unwrap(await this.bridge.diff(request));
  }

  async stage(request: GitPathsRequest): Promise<GitStageResult> {
    return unwrap(await this.bridge.stage(request));
  }

  async unstage(request: GitPathsRequest): Promise<GitStageResult> {
    return unwrap(await this.bridge.unstage(request));
  }

  async commit(request: GitCommitRequest): Promise<GitCommitResult> {
    return unwrap(await this.bridge.commit(request));
  }

  async checkoutBranch(request: GitBranchRequest): Promise<GitBranchMutationResult> {
    return unwrap(await this.bridge.checkoutBranch(request));
  }

  async createBranch(request: GitBranchRequest): Promise<GitBranchMutationResult> {
    return unwrap(await this.bridge.createBranch(request));
  }

  async conflicts(request: GitWorkspaceRequest): Promise<GitConflicts> {
    return unwrap(await this.bridge.conflicts(request));
  }

  onDidChange(callback: (event: GitChangeEvent) => void) {
    const dispose = this.bridge.onDidChange(callback);
    return typeof dispose === "function" ? dispose : () => undefined;
  }
}

class DemoGitApi implements GitApi {
  readonly source = "demo" as const;

  private unavailable(): never {
    throw new GitApiError(
      "NOT_A_REPOSITORY",
      "Open a Git repository to use source control.",
    );
  }

  async summary(_request: GitWorkspaceRequest): Promise<GitRepositorySummary> {
    return this.unavailable();
  }

  async status(_request: GitWorkspaceRequest): Promise<GitStatus> {
    return this.unavailable();
  }

  async branches(_request: GitWorkspaceRequest): Promise<GitBranches> {
    return this.unavailable();
  }

  async log(_request: GitLogRequest): Promise<GitLog> {
    return this.unavailable();
  }

  async diff(_request: GitDiffRequest): Promise<GitFileDiff> {
    return this.unavailable();
  }

  async stage(_request: GitPathsRequest): Promise<GitStageResult> {
    return this.unavailable();
  }

  async unstage(_request: GitPathsRequest): Promise<GitStageResult> {
    return this.unavailable();
  }

  async commit(_request: GitCommitRequest): Promise<GitCommitResult> {
    return this.unavailable();
  }

  async checkoutBranch(_request: GitBranchRequest): Promise<GitBranchMutationResult> {
    return this.unavailable();
  }

  async createBranch(_request: GitBranchRequest): Promise<GitBranchMutationResult> {
    return this.unavailable();
  }

  async conflicts(_request: GitWorkspaceRequest): Promise<GitConflicts> {
    return this.unavailable();
  }

  onDidChange(_callback: (event: GitChangeEvent) => void) {
    return () => undefined;
  }
}

export function createGitApi(bridge?: CollabGitBridge): GitApi {
  const nativeBridge = bridge ?? (typeof window !== "undefined" ? window.collabGit : undefined);
  return nativeBridge ? new ElectronGitApi(nativeBridge) : new DemoGitApi();
}

export const gitApi = createGitApi();
