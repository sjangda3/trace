import { randomUUID } from "node:crypto";
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
  type CreateInviteInput,
  type CreateWorkspaceInput,
  type RedeemInviteInput,
} from "../repository.js";

type StoredInvite = InviteMetadata & {
  tokenHash: string;
  redeemedAt: string | null;
  redeemedByUserId: string | null;
};

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
      if (
        !invite ||
        invite.redeemedAt !== null ||
        Date.parse(invite.expiresAt) <= now.getTime()
      ) {
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }
      const workspace = this.#workspaces.get(invite.workspaceId);
      const members = this.#members.get(invite.workspaceId);
      if (!workspace || !members) {
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }
      if (members.has(input.actor.userId)) {
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
    };
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
