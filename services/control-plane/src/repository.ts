import type {
  AuthenticatedActor,
  InviteMetadata,
  RepositoryBinding,
  RedeemedInvite,
  RoomSnapshotState,
  Workspace,
  WorkspaceBootstrapState,
  WorkspaceMember,
} from "./domain.js";
import type {
  AccountUser,
  AuthTokenKind,
  CreateAccountInput,
  CreateDeviceSessionInput,
  CreateOneTimeTokenInput,
  DeviceSession,
  DeviceSessionRotation,
  GitHubIdentity,
  GitHubOAuthTransaction,
  LinkGitHubIdentityInput,
  RotateDeviceSessionInput,
  StoredAccount,
} from "./accounts.js";
import type { GitHubInstallation, GitHubInstallationAccess, GitHubRepository } from "./github-auth.js";

export const MAX_WORKSPACE_MEMBERS = 50;
export const MAX_ACTIVE_INVITES = 20;
export const MIN_INVITE_LIFETIME_SECONDS = 300;
export const MAX_INVITE_LIFETIME_SECONDS = 604_800;
const INVITE_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
const PRINTABLE_ASCII_PATTERN = /^[ -~]+$/;
const FORBIDDEN_BRANCH_CHARACTERS = new Set(["~", "^", ":", "?", "*", "[", "]", "\\"]);

export function assertRepositoryBinding(repository: RepositoryBinding): void {
  const validOwner =
    repository.owner.length <= 39 && GITHUB_OWNER_PATTERN.test(repository.owner);
  const validName =
    repository.name.length <= 100 &&
    GITHUB_REPOSITORY_PATTERN.test(repository.name) &&
    !repository.name.startsWith(".") &&
    !repository.name.endsWith(".git");
  const validDefaultBranch =
    repository.defaultBranch.length <= 255 &&
    repository.defaultBranch.trim().length > 0 &&
    PRINTABLE_ASCII_PATTERN.test(repository.defaultBranch) &&
    !repository.defaultBranch.startsWith("/") &&
    !repository.defaultBranch.includes("..") &&
    ![...repository.defaultBranch].some((character) =>
      FORBIDDEN_BRANCH_CHARACTERS.has(character),
    );
  if (repository.provider !== "github" || !validOwner || !validName || !validDefaultBranch) {
    throw new TypeError("The repository binding is invalid.");
  }
}

export function assertInviteTokenHash(tokenHash: string): void {
  if (!INVITE_TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new TypeError("A 64-character lowercase invite token hash is required.");
  }
}

export function assertInviteLifetime(expiresInSeconds: number): void {
  if (
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < MIN_INVITE_LIFETIME_SECONDS ||
    expiresInSeconds > MAX_INVITE_LIFETIME_SECONDS
  ) {
    throw new TypeError("The invite lifetime is outside the supported bounds.");
  }
}

export type RepositoryErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "NOT_MEMBER"
  | "ROLE_REQUIRED"
  | "ACTIVE_INVITE_LIMIT"
  | "INVITE_TOKEN_COLLISION"
  | "INVITE_UNAVAILABLE"
  | "ALREADY_MEMBER"
  | "MEMBER_LIMIT";

export class RepositoryError extends Error {
  constructor(readonly code: RepositoryErrorCode, message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

export type CreateWorkspaceInput = {
  name: string;
  actor: AuthenticatedActor;
  repository?: RepositoryBinding;
  githubInstallationId?: string;
};

export type CreateInviteInput = {
  workspaceId: string;
  actor: AuthenticatedActor;
  tokenHash: string;
  expiresInSeconds: number;
  recipientEmail?: string;
};

export type RedeemInviteInput = {
  tokenHash: string;
  actor: AuthenticatedActor;
};

export type CreateGitHubOAuthTransactionInput = Omit<GitHubOAuthTransaction, "id" | "consumedAt">;

export interface ControlPlaneRepository {
  health(): Promise<void>;
  createWorkspace(input: CreateWorkspaceInput): Promise<{
    workspace: Workspace;
    membership: WorkspaceMember;
  }>;
  getWorkspace(workspaceId: string): Promise<Workspace | null>;
  getMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  createInvite(input: CreateInviteInput): Promise<InviteMetadata>;
  redeemInvite(input: RedeemInviteInput): Promise<RedeemedInvite>;
  getWorkspaceBootstrapState(workspaceId: string): Promise<WorkspaceBootstrapState | null>;
  /** @deprecated Use getWorkspaceBootstrapState and project the REST fields explicitly. */
  getRoomSnapshotState(workspaceId: string): Promise<RoomSnapshotState | null>;
  createAccount(input: CreateAccountInput): Promise<AccountUser | null>;
  getAccountByEmail(email: string): Promise<StoredAccount | null>;
  getAccountById(userId: string): Promise<StoredAccount | null>;
  replacePassword(userId: string, passwordHash: string): Promise<boolean>;
  markEmailVerified(userId: string): Promise<AccountUser | null>;
  createOneTimeToken(input: CreateOneTimeTokenInput): Promise<void>;
  consumeOneTimeToken(kind: AuthTokenKind, tokenHash: string): Promise<AccountUser | null>;
  createDeviceSession(input: CreateDeviceSessionInput): Promise<DeviceSession>;
  rotateDeviceSession(input: RotateDeviceSessionInput): Promise<DeviceSessionRotation>;
  revokeDeviceSession(refreshTokenHash: string): Promise<void>;
  isDeviceSessionActive(sessionId: string, userId: string): Promise<boolean>;
  revokeAllDeviceSessions(userId: string): Promise<void>;
  createGitHubOAuthTransaction(input: CreateGitHubOAuthTransactionInput): Promise<GitHubOAuthTransaction>;
  consumeGitHubOAuthTransaction(stateHash: string): Promise<GitHubOAuthTransaction | null>;
  getGitHubIdentity(userId: string): Promise<GitHubIdentity | null>;
  linkGitHubIdentity(input: LinkGitHubIdentityInput): Promise<GitHubIdentity | "conflict">;
  replaceGitHubInstallationAccess(userId: string, installations: GitHubInstallationAccess[]): Promise<void>;
  listGitHubInstallations(userId: string, notBefore: string): Promise<GitHubInstallation[]>;
  listGitHubRepositories(userId: string, installationId: string, notBefore: string): Promise<GitHubRepository[]>;
}
