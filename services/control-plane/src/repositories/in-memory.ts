import { randomUUID } from "node:crypto";
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
} from "../accounts.js";
import type { GitHubInstallation, GitHubInstallationAccess, GitHubRepository } from "../github-auth.js";
import type {
  CodeControl,
  InviteMetadata,
  RepositoryBinding,
  RedeemedInvite,
  RoomSnapshotState,
  Workspace,
  WorkspaceBootstrapState,
  WorkspaceMember,
  WorkspaceWriterControl,
} from "../domain.js";
import {
  MAX_ACTIVE_INVITES,
  MAX_WORKSPACE_MEMBERS,
  RepositoryError,
  assertInviteLifetime,
  assertInviteTokenHash,
  assertRepositoryBinding,
  type ControlPlaneRepository,
  type CreateGitHubOAuthTransactionInput,
  type CreateInviteInput,
  type CreateWorkspaceInput,
  type RedeemInviteInput,
} from "../repository.js";

type StoredInvite = InviteMetadata & {
  tokenHash: string;
  redeemedAt: string | null;
  redeemedByUserId: string | null;
};

type StoredOneTimeToken = CreateOneTimeTokenInput & { consumedAt: string | null };
type StoredGitHubInstallationAccess = GitHubInstallationAccess & { linkedAt: string };

type StoredControl = {
  holderUserId: string | null;
  holderClientId: string | null;
  leaseExpiresAt: string | null;
  version: number;
  fence: number;
  typingCount: number;
  typingUntil: string | null;
};

export type InMemoryRepositoryOptions = {
  clock?: () => Date;
  idFactory?: () => string;
  maxMembers?: number;
  maxActiveInvites?: number;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Process-local development storage. Writes are serialized and every returned
 * object is cloned so callers cannot mutate repository state by reference.
 */
export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #maxMembers: number;
  readonly #maxActiveInvites: number;
  readonly #workspaces = new Map<string, Workspace>();
  readonly #repositories = new Map<string, RepositoryBinding | null>();
  readonly #members = new Map<string, Map<string, WorkspaceMember>>();
  readonly #invites = new Map<string, StoredInvite>();
  readonly #inviteIdsByHash = new Map<string, string>();
  readonly #controls = new Map<string, StoredControl>();
  readonly #accounts = new Map<string, StoredAccount>();
  readonly #accountIdsByEmail = new Map<string, string>();
  readonly #oneTimeTokens = new Map<string, StoredOneTimeToken>();
  readonly #sessions = new Map<string, DeviceSession>();
  readonly #sessionIdsByHash = new Map<string, string>();
  readonly #githubIdentities = new Map<string, GitHubIdentity>();
  readonly #githubUserIdsBySubject = new Map<string, string>();
  readonly #githubInstallationAccess = new Map<string, Map<string, StoredGitHubInstallationAccess>>();
  readonly #oauthTransactions = new Map<string, GitHubOAuthTransaction>();
  readonly #oauthTransactionIdsByStateHash = new Map<string, string>();
  #writeBarrier: Promise<void> = Promise.resolve();

  constructor(options: InMemoryRepositoryOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#maxMembers = options.maxMembers ?? MAX_WORKSPACE_MEMBERS;
    this.#maxActiveInvites = options.maxActiveInvites ?? MAX_ACTIVE_INVITES;
    if (!Number.isSafeInteger(this.#maxMembers) || this.#maxMembers < 1) {
      throw new Error("The in-memory member limit is invalid.");
    }
    if (!Number.isSafeInteger(this.#maxActiveInvites) || this.#maxActiveInvites < 1) {
      throw new Error("The in-memory invite limit is invalid.");
    }
  }

  async health(): Promise<void> {
    await this.#read(() => undefined);
  }

  createWorkspace(input: CreateWorkspaceInput) {
    return this.#write(() => {
      if (input.repository) assertRepositoryBinding(input.repository);
      const now = this.#now();
      const workspace: Workspace = {
        id: this.#idFactory(),
        roomId: this.#idFactory(),
        name: input.name,
        state: "created",
        roomSequence: 0,
        createdByUserId: input.actor.userId,
        createdAt: now,
      };
      const membership: WorkspaceMember = {
        memberId: this.#idFactory(),
        workspaceId: workspace.id,
        userId: input.actor.userId,
        displayName: input.actor.displayName,
        role: "owner",
        joinedAt: now,
      };
      const control: StoredControl = {
        holderUserId: null,
        holderClientId: null,
        leaseExpiresAt: null,
        version: 0,
        fence: 0,
        typingCount: 0,
        typingUntil: null,
      };
      this.#workspaces.set(workspace.id, workspace);
      this.#repositories.set(workspace.id, input.repository ? clone(input.repository) : null);
      this.#members.set(workspace.id, new Map([[membership.userId, membership]]));
      this.#controls.set(workspace.id, control);
      return clone({ workspace, membership });
    });
  }

  getWorkspace(workspaceId: string): Promise<Workspace | null> {
    return this.#read(() => clone(this.#workspaces.get(workspaceId) ?? null));
  }

  getMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    return this.#read(() => clone(this.#members.get(workspaceId)?.get(userId) ?? null));
  }

  listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.#read(() => {
      const members = this.#members.get(workspaceId);
      if (!members) {
        throw new RepositoryError("WORKSPACE_NOT_FOUND", "The workspace does not exist.");
      }
      return clone(
        [...members.values()].sort((left, right) => {
          if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
          return left.joinedAt.localeCompare(right.joinedAt) || left.userId.localeCompare(right.userId);
        }),
      );
    });
  }

  createInvite(input: CreateInviteInput): Promise<InviteMetadata> {
    return this.#write(() => {
      assertInviteTokenHash(input.tokenHash);
      assertInviteLifetime(input.expiresInSeconds);
      if (!this.#workspaces.has(input.workspaceId)) {
        throw new RepositoryError("WORKSPACE_NOT_FOUND", "The workspace does not exist.");
      }
      const membership = this.#members.get(input.workspaceId)?.get(input.actor.userId);
      if (!membership) {
        throw new RepositoryError("NOT_MEMBER", "The actor is not a workspace member.");
      }
      if (membership.role !== "owner") {
        throw new RepositoryError("ROLE_REQUIRED", "Workspace owner access is required.");
      }
      if (this.#inviteIdsByHash.has(input.tokenHash)) {
        throw new RepositoryError("INVITE_TOKEN_COLLISION", "The invite token already exists.");
      }

      const nowDate = this.#nowDate();
      const activeInvites = [...this.#invites.values()].filter(
        (invite) =>
          invite.workspaceId === input.workspaceId &&
          invite.redeemedAt === null &&
          Date.parse(invite.expiresAt) > nowDate.getTime(),
      ).length;
      if (activeInvites >= this.#maxActiveInvites) {
        throw new RepositoryError("ACTIVE_INVITE_LIMIT", "The workspace has too many active invites.");
      }

      const expiresAt = new Date(nowDate.getTime() + input.expiresInSeconds * 1_000).toISOString();
      const invite: StoredInvite = {
        id: this.#idFactory(),
        workspaceId: input.workspaceId,
        role: "member",
        createdByUserId: input.actor.userId,
        createdAt: nowDate.toISOString(),
        expiresAt,
        recipientEmail: input.recipientEmail ?? null,
        tokenHash: input.tokenHash,
        redeemedAt: null,
        redeemedByUserId: null,
      };
      this.#invites.set(invite.id, invite);
      this.#inviteIdsByHash.set(invite.tokenHash, invite.id);
      return clone(this.#publicInvite(invite));
    });
  }

  redeemInvite(input: RedeemInviteInput): Promise<RedeemedInvite> {
    return this.#write(() => {
      assertInviteTokenHash(input.tokenHash);
      const inviteId = this.#inviteIdsByHash.get(input.tokenHash);
      const invite = inviteId ? this.#invites.get(inviteId) : undefined;
      const now = this.#nowDate();
      if (!invite || Date.parse(invite.expiresAt) <= now.getTime()) {
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }
      const workspace = this.#workspaces.get(invite.workspaceId);
      const members = this.#members.get(invite.workspaceId);
      if (!workspace || !members) {
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }
      if (invite.recipientEmail && input.actor.email !== invite.recipientEmail) {
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }
      const existingMembership = members.get(input.actor.userId);
      if (invite.redeemedAt !== null) {
        if (invite.redeemedByUserId === input.actor.userId && existingMembership) {
          return clone({ workspace, membership: existingMembership });
        }
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }
      if (existingMembership) {
        throw new RepositoryError("ALREADY_MEMBER", "The user is already a workspace member.");
      }
      if (members.size >= this.#maxMembers) {
        throw new RepositoryError("MEMBER_LIMIT", "The workspace has reached its member limit.");
      }

      const membership: WorkspaceMember = {
        memberId: this.#idFactory(),
        workspaceId: workspace.id,
        userId: input.actor.userId,
        displayName: input.actor.displayName,
        role: "member",
        joinedAt: now.toISOString(),
      };
      members.set(membership.userId, membership);
      invite.redeemedAt = now.toISOString();
      invite.redeemedByUserId = input.actor.userId;
      return clone({ workspace, membership });
    });
  }

  getRoomSnapshotState(workspaceId: string): Promise<RoomSnapshotState | null> {
    return this.#read(() => {
      const workspace = this.#workspaces.get(workspaceId);
      const control = this.#controls.get(workspaceId);
      if (!workspace || !control) return null;
      return clone({ workspace, codeControl: this.#codeControl(control) });
    });
  }

  getWorkspaceBootstrapState(workspaceId: string): Promise<WorkspaceBootstrapState | null> {
    return this.#read(() => {
      const workspace = this.#workspaces.get(workspaceId);
      const control = this.#controls.get(workspaceId);
      const membersByUserId = this.#members.get(workspaceId);
      if (!workspace || !control || !membersByUserId) return null;
      const members = this.#orderedMembers(membersByUserId);
      const ownerMemberId = control.holderUserId
        ? membersByUserId.get(control.holderUserId)?.memberId ?? null
        : null;
      const writerControl: WorkspaceWriterControl = {
        resource: { kind: "workspace", channel: "editor" },
        ownerMemberId,
        ownerClientId: control.holderClientId,
        leaseExpiresAt: control.leaseExpiresAt,
        version: control.version,
        fence: control.fence,
        typingCount: control.typingCount,
        typingUntil: control.typingUntil,
      };
      return clone({
        workspace,
        repository: this.#repositories.get(workspaceId) ?? null,
        members,
        codeControl: this.#codeControl(control),
        writerControl,
      });
    });
  }

  createAccount(input: CreateAccountInput): Promise<AccountUser | null> {
    return this.#write(() => {
      if (this.#accountIdsByEmail.has(input.email)) return null;
      const user: StoredAccount = {
        id: this.#idFactory(),
        email: input.email,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        emailVerifiedAt: null,
        createdAt: this.#now(),
      };
      this.#accounts.set(user.id, user);
      this.#accountIdsByEmail.set(user.email, user.id);
      return clone(this.#publicAccount(user));
    });
  }

  getAccountByEmail(email: string): Promise<StoredAccount | null> {
    return this.#read(() => {
      const id = this.#accountIdsByEmail.get(email);
      return clone(id ? this.#accounts.get(id) ?? null : null);
    });
  }

  getAccountById(userId: string): Promise<StoredAccount | null> {
    return this.#read(() => clone(this.#accounts.get(userId) ?? null));
  }

  replacePassword(userId: string, passwordHash: string): Promise<boolean> {
    return this.#write(() => {
      const user = this.#accounts.get(userId);
      if (!user) return false;
      user.passwordHash = passwordHash;
      return true;
    });
  }

  markEmailVerified(userId: string): Promise<AccountUser | null> {
    return this.#write(() => {
      const user = this.#accounts.get(userId);
      if (!user) return null;
      if (!user.emailVerifiedAt) user.emailVerifiedAt = this.#now();
      return clone(this.#publicAccount(user));
    });
  }

  createOneTimeToken(input: CreateOneTimeTokenInput): Promise<void> {
    return this.#write(() => {
      this.#oneTimeTokens.set(input.tokenHash, { ...input, consumedAt: null });
    });
  }

  consumeOneTimeToken(kind: AuthTokenKind, tokenHash: string): Promise<AccountUser | null> {
    return this.#write(() => {
      const token = this.#oneTimeTokens.get(tokenHash);
      if (!token || token.kind !== kind || token.consumedAt || Date.parse(token.expiresAt) <= this.#nowDate().getTime()) return null;
      const user = this.#accounts.get(token.userId);
      if (!user) return null;
      token.consumedAt = this.#now();
      return clone(this.#publicAccount(user));
    });
  }

  createDeviceSession(input: CreateDeviceSessionInput): Promise<DeviceSession> {
    return this.#write(() => {
      const session: DeviceSession = {
        id: this.#idFactory(),
        userId: input.userId,
        deviceId: input.deviceId,
        refreshTokenHash: input.refreshTokenHash,
        createdAt: this.#now(),
        expiresAt: input.expiresAt,
        lastUsedAt: this.#now(),
        revokedAt: null,
        replacedBySessionId: null,
      };
      this.#sessions.set(session.id, session);
      this.#sessionIdsByHash.set(session.refreshTokenHash, session.id);
      return clone(session);
    });
  }

  rotateDeviceSession(input: RotateDeviceSessionInput): Promise<DeviceSessionRotation> {
    return this.#write(() => {
      const previousId = this.#sessionIdsByHash.get(input.previousRefreshTokenHash);
      const previous = previousId ? this.#sessions.get(previousId) : undefined;
      if (!previous) return { kind: "missing" };
      const now = this.#now();
      if (previous.revokedAt || previous.replacedBySessionId || Date.parse(previous.expiresAt) <= Date.parse(now)) {
        for (const session of this.#sessions.values()) {
          if (session.userId === previous.userId && !session.revokedAt) session.revokedAt = now;
        }
        return { kind: "reused-or-revoked" };
      }
      const user = this.#accounts.get(previous.userId);
      if (!user) return { kind: "missing" };
      const session: DeviceSession = {
        id: this.#idFactory(), userId: previous.userId, deviceId: input.deviceId,
        refreshTokenHash: input.refreshTokenHash, createdAt: now, expiresAt: input.expiresAt,
        lastUsedAt: now, revokedAt: null, replacedBySessionId: null,
      };
      previous.replacedBySessionId = session.id;
      previous.lastUsedAt = now;
      this.#sessions.set(session.id, session);
      this.#sessionIdsByHash.set(session.refreshTokenHash, session.id);
      return { kind: "rotated", user: clone(this.#publicAccount(user)), session: clone(session) };
    });
  }

  revokeDeviceSession(refreshTokenHash: string): Promise<void> {
    return this.#write(() => {
      const session = this.#sessions.get(this.#sessionIdsByHash.get(refreshTokenHash) ?? "");
      if (session && !session.revokedAt) session.revokedAt = this.#now();
    });
  }

  isDeviceSessionActive(sessionId: string, userId: string): Promise<boolean> {
    return this.#read(() => {
      const session = this.#sessions.get(sessionId);
      return Boolean(session && session.userId === userId && !session.revokedAt && !session.replacedBySessionId && Date.parse(session.expiresAt) > this.#nowDate().getTime());
    });
  }

  revokeAllDeviceSessions(userId: string): Promise<void> {
    return this.#write(() => {
      const now = this.#now();
      for (const session of this.#sessions.values()) if (session.userId === userId && !session.revokedAt) session.revokedAt = now;
    });
  }

  createGitHubOAuthTransaction(input: CreateGitHubOAuthTransactionInput): Promise<GitHubOAuthTransaction> {
    return this.#write(() => {
      const transaction: GitHubOAuthTransaction = { id: this.#idFactory(), ...input, consumedAt: null };
      this.#oauthTransactions.set(transaction.id, transaction);
      this.#oauthTransactionIdsByStateHash.set(transaction.stateHash, transaction.id);
      return clone(transaction);
    });
  }

  consumeGitHubOAuthTransaction(stateHash: string): Promise<GitHubOAuthTransaction | null> {
    return this.#write(() => {
      const transaction = this.#oauthTransactions.get(this.#oauthTransactionIdsByStateHash.get(stateHash) ?? "");
      if (!transaction || transaction.consumedAt || Date.parse(transaction.expiresAt) <= this.#nowDate().getTime()) return null;
      transaction.consumedAt = this.#now();
      return clone(transaction);
    });
  }

  getGitHubIdentity(userId: string): Promise<GitHubIdentity | null> {
    return this.#read(() => clone(this.#githubIdentities.get(userId) ?? null));
  }

  linkGitHubIdentity(input: LinkGitHubIdentityInput): Promise<GitHubIdentity | "conflict"> {
    return this.#write(() => {
      const existingUserId = this.#githubUserIdsBySubject.get(input.providerSubject);
      if (existingUserId && existingUserId !== input.userId) return "conflict";
      const previous = this.#githubIdentities.get(input.userId);
      if (previous && previous.providerSubject !== input.providerSubject) this.#githubUserIdsBySubject.delete(previous.providerSubject);
      const identity: GitHubIdentity = { ...input, linkedAt: this.#now() };
      this.#githubIdentities.set(input.userId, identity);
      this.#githubUserIdsBySubject.set(input.providerSubject, input.userId);
      return clone(identity);
    });
  }

  replaceGitHubInstallationAccess(userId: string, installations: GitHubInstallationAccess[]): Promise<void> {
    return this.#write(() => {
      const next = new Map<string, StoredGitHubInstallationAccess>();
      const linkedAt = this.#now();
      for (const installation of installations) {
        next.set(installation.id, { ...clone(installation), linkedAt });
      }
      this.#githubInstallationAccess.set(userId, next);
    });
  }

  listGitHubInstallations(userId: string, notBefore: string): Promise<GitHubInstallation[]> {
    return this.#read(() => {
      const installations = this.#githubInstallationAccess.get(userId);
      return clone([...(installations?.values() ?? [])]
        .filter((installation) => installation.linkedAt > notBefore)
        .map(({ id, accountLogin, accountType }) => ({ id, accountLogin, accountType })));
    });
  }

  listGitHubRepositories(userId: string, installationId: string, notBefore: string): Promise<GitHubRepository[]> {
    return this.#read(() => {
      const installation = this.#githubInstallationAccess.get(userId)?.get(installationId);
      return clone(installation && installation.linkedAt > notBefore ? installation.repositories : []);
    });
  }

  #codeControl(control: StoredControl): CodeControl {
    return {
      resource: "code",
      holderUserId: control.holderUserId,
      version: control.version,
      fence: control.fence,
      typingCount: control.typingCount,
      typingUntil: control.typingUntil,
    };
  }

  #orderedMembers(members: Map<string, WorkspaceMember>): WorkspaceMember[] {
    return [...members.values()].sort((left, right) => {
      if (left.role !== right.role) return left.role === "owner" ? -1 : 1;
      return left.joinedAt.localeCompare(right.joinedAt) || left.userId.localeCompare(right.userId);
    });
  }

  #publicInvite(invite: StoredInvite): InviteMetadata {
    return {
      id: invite.id,
      workspaceId: invite.workspaceId,
      role: invite.role,
      createdByUserId: invite.createdByUserId,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      recipientEmail: invite.recipientEmail,
    };
  }

  #publicAccount(user: StoredAccount): AccountUser {
    const { passwordHash: _passwordHash, ...account } = user;
    return account;
  }

  #nowDate(): Date {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The in-memory repository clock returned an invalid date.");
    }
    return new Date(value.getTime());
  }

  #now(): string {
    return this.#nowDate().toISOString();
  }

  #write<T>(operation: () => T): Promise<T> {
    const result = this.#writeBarrier.then(operation);
    this.#writeBarrier = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #read<T>(operation: () => T): Promise<T> {
    await this.#writeBarrier;
    return operation();
  }
}
