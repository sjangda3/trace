import type { RawResult } from "../editor/bridge";

export type TraceAccount = {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  githubLinked: boolean;
};

export type TraceAccountState = {
  availability: "ready" | "not-configured";
  user: TraceAccount | null;
  message: string | null;
};

export type GitHubAppInstallation = { id: string; accountLogin: string; accountType: "User" | "Organization" };
export type CloudRepository = { id: string; owner: string; name: string; defaultBranch: string; private: boolean };
export type CloudWorkspace = { id: string; name: string; roomId: string };

export interface TraceAccountBridge {
  state(): Promise<RawResult<TraceAccountState>>;
  signUp(request: { email: string; displayName: string; password: string }): Promise<RawResult<{ accepted: true }>>;
  signIn(request: { email: string; password: string }): Promise<RawResult<{ user: TraceAccount }>>;
  resendVerification(request: { email: string }): Promise<RawResult<{ accepted: true }>>;
  requestPasswordReset(request: { email: string }): Promise<RawResult<{ accepted: true }>>;
  confirmPasswordReset(request: { token: string; password: string }): Promise<RawResult<{ accepted: true }>>;
  refreshState(): Promise<RawResult<{ user: TraceAccount | null }>>;
  signOut(): Promise<RawResult<{ signedOut: true }>>;
  beginGitHubLink(): Promise<RawResult<{ opened: true }>>;
  openGitHubAppInstall(): Promise<RawResult<{ opened: true }>>;
  listInstallations(): Promise<RawResult<GitHubAppInstallation[]>>;
  listRepositories(installationId: string): Promise<RawResult<CloudRepository[]>>;
  createWorkspace(request: { name: string; installationId: string; repository: Pick<CloudRepository, "owner" | "name" | "defaultBranch"> }): Promise<RawResult<{ workspace: CloudWorkspace; membership: { role: "owner" } }>>;
  createInvite(request: { workspaceId: string; email: string; expiresInSeconds?: number }): Promise<RawResult<{ invite: { token: string; link?: string; expiresAt: string } }>>;
  redeemInvite(request: { tokenOrLink: string }): Promise<RawResult<{ workspace: CloudWorkspace; membership: { role: "member" | "owner" } }>>;
  pendingInvite(): Promise<RawResult<{ pending: boolean }>>;
  redeemPendingInvite(): Promise<RawResult<{ workspace: CloudWorkspace; membership: { role: "member" | "owner" } }>>;
  pendingPasswordReset(): Promise<RawResult<{ pending: boolean }>>;
  confirmPendingPasswordReset(request: { password: string }): Promise<RawResult<{ accepted: true }>>;
  onDeepLink(callback: (event: { kind: "invite" | "password-reset" }) => void): () => void;
}

declare global {
  interface Window { traceAccount?: TraceAccountBridge; }
}
