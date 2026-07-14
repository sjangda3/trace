import type { RawResult } from "../editor/bridge";
import type {
  CollabGitHubBridge,
  GitHubApi,
  GitHubChangeEvent,
  GitHubDeviceFlow,
  GitHubDeviceFlowPollResult,
  GitHubDeviceFlowRequest,
  GitHubIssueDetail,
  GitHubIssueSummary,
  GitHubListResult,
  GitHubNumberRequest,
  GitHubPullRequestDetail,
  GitHubPullRequestSummary,
  GitHubWorkspaceRequest,
  GitHubWorkspaceState,
} from "./types";

export class GitHubApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function unwrap<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw new GitHubApiError(result.error.code, result.error.message);
}

class ElectronGitHubApi implements GitHubApi {
  readonly source = "electron" as const;

  constructor(private readonly bridge: CollabGitHubBridge) {}

  async state(request: GitHubWorkspaceRequest): Promise<GitHubWorkspaceState> {
    return unwrap(await this.bridge.state(request));
  }

  async beginDeviceFlow(request: GitHubWorkspaceRequest): Promise<GitHubDeviceFlow> {
    return unwrap(await this.bridge.beginDeviceFlow(request));
  }

  async openDeviceFlow(request: GitHubDeviceFlowRequest): Promise<{ opened: true }> {
    return unwrap(await this.bridge.openDeviceFlow(request));
  }

  async pollDeviceFlow(request: GitHubDeviceFlowRequest): Promise<GitHubDeviceFlowPollResult> {
    return unwrap(await this.bridge.pollDeviceFlow(request));
  }

  async cancelDeviceFlow(request: GitHubDeviceFlowRequest): Promise<GitHubWorkspaceState> {
    return unwrap(await this.bridge.cancelDeviceFlow(request));
  }

  async disconnect(request: GitHubWorkspaceRequest): Promise<GitHubWorkspaceState> {
    return unwrap(await this.bridge.disconnect(request));
  }

  async listPullRequests(request: GitHubWorkspaceRequest): Promise<GitHubListResult<GitHubPullRequestSummary>> {
    return unwrap(await this.bridge.listPullRequests(request));
  }

  async listIssues(request: GitHubWorkspaceRequest): Promise<GitHubListResult<GitHubIssueSummary>> {
    return unwrap(await this.bridge.listIssues(request));
  }

  async getPullRequest(request: GitHubNumberRequest): Promise<GitHubPullRequestDetail> {
    return unwrap(await this.bridge.getPullRequest(request));
  }

  async getIssue(request: GitHubNumberRequest): Promise<GitHubIssueDetail> {
    return unwrap(await this.bridge.getIssue(request));
  }

  onDidChange(callback: (event: GitHubChangeEvent) => void): () => void {
    const dispose = this.bridge.onDidChange(callback);
    return typeof dispose === "function" ? dispose : () => undefined;
  }
}

class UnavailableGitHubApi implements GitHubApi {
  readonly source = "unavailable" as const;

  private unavailable(): never {
    throw new GitHubApiError(
      "CONFIG_REQUIRED",
      "GitHub integration is not configured in this build.",
    );
  }

  async state(request: GitHubWorkspaceRequest): Promise<GitHubWorkspaceState> {
    return {
      workspaceId: request.workspaceId,
      status: "config-required",
      repository: null,
      account: null,
      message: "GitHub integration is not configured in this build.",
      installationUrl: null,
      lastSyncedAt: null,
      hasCachedData: false,
    };
  }

  async beginDeviceFlow(_request: GitHubWorkspaceRequest): Promise<GitHubDeviceFlow> {
    return this.unavailable();
  }

  async openDeviceFlow(_request: GitHubDeviceFlowRequest): Promise<{ opened: true }> {
    return this.unavailable();
  }

  async pollDeviceFlow(_request: GitHubDeviceFlowRequest): Promise<GitHubDeviceFlowPollResult> {
    return this.unavailable();
  }

  async cancelDeviceFlow(_request: GitHubDeviceFlowRequest): Promise<GitHubWorkspaceState> {
    return this.unavailable();
  }

  async disconnect(_request: GitHubWorkspaceRequest): Promise<GitHubWorkspaceState> {
    return this.unavailable();
  }

  async listPullRequests(_request: GitHubWorkspaceRequest): Promise<GitHubListResult<GitHubPullRequestSummary>> {
    return this.unavailable();
  }

  async listIssues(_request: GitHubWorkspaceRequest): Promise<GitHubListResult<GitHubIssueSummary>> {
    return this.unavailable();
  }

  async getPullRequest(_request: GitHubNumberRequest): Promise<GitHubPullRequestDetail> {
    return this.unavailable();
  }

  async getIssue(_request: GitHubNumberRequest): Promise<GitHubIssueDetail> {
    return this.unavailable();
  }

  onDidChange(_callback: (event: GitHubChangeEvent) => void): () => void {
    return () => undefined;
  }
}

export function createGitHubApi(bridge?: CollabGitHubBridge): GitHubApi {
  const nativeBridge = bridge ?? (typeof window !== "undefined" ? window.collabGitHub : undefined);
  return nativeBridge ? new ElectronGitHubApi(nativeBridge) : new UnavailableGitHubApi();
}

export const githubApi = createGitHubApi();
