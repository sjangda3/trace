import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type {
  AuthenticatedActor,
  CodeControl,
  InviteMetadata,
  RepositoryBinding,
  RedeemedInvite,
  RoomSnapshotState,
  Workspace,
  WorkspaceBootstrapState,
  WorkspaceMember,
  WorkspaceRole,
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

interface WorkspaceRow extends QueryResultRow {
  id: string;
  room_id: string;
  name: string;
  state: string;
  room_sequence: string | number;
  created_by_user_id: string;
  created_at: Date | string;
}

interface MemberRow extends QueryResultRow {
  member_id: string;
  workspace_id: string;
  user_id: string;
  display_name: string;
  role: string;
  joined_at: Date | string;
}

interface InviteRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  role: string;
  created_by_user_id: string;
  created_at: Date | string;
  expires_at: Date | string;
  redeemed_at: Date | string | null;
}

interface SnapshotRow extends WorkspaceRow {
  repository_provider: string | null;
  repository_owner: string | null;
  repository_name: string | null;
  repository_default_branch: string | null;
  holder_user_id: string | null;
  holder_member_id: string | null;
  holder_client_id: string | null;
  lease_expires_at: Date | string | null;
  control_version: string | number;
  control_fence: string | number;
  typing_count: string | number;
  typing_until: Date | string | null;
}

export type PostgresRepositoryOptions = {
  clock?: () => Date;
  idFactory?: () => string;
  maxMembers?: number;
  maxActiveInvites?: number;
};

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("PostgreSQL returned an invalid timestamp.");
  return date.toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function safeCounter(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}.`);
  }
  return parsed;
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  if (row.state !== "created") throw new Error("PostgreSQL returned an unsupported workspace state.");
  return {
    id: row.id,
    roomId: row.room_id,
    name: row.name,
    state: "created",
    roomSequence: safeCounter(row.room_sequence, "room sequence"),
    createdByUserId: row.created_by_user_id,
    createdAt: timestamp(row.created_at),
  };
}

function memberFromRow(row: MemberRow): WorkspaceMember {
  if (row.role !== "owner" && row.role !== "member") {
    throw new Error("PostgreSQL returned an invalid workspace role.");
  }
  return {
    memberId: row.member_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    joinedAt: timestamp(row.joined_at),
  };
}

function repositoryBindingFromRow(row: SnapshotRow): RepositoryBinding | null {
  const values = [
    row.repository_provider,
    row.repository_owner,
    row.repository_name,
    row.repository_default_branch,
  ];
  if (values.every((value) => value === null)) return null;
  if (
    row.repository_provider !== "github" ||
    row.repository_owner === null ||
    row.repository_name === null ||
    row.repository_default_branch === null
  ) {
    throw new Error("PostgreSQL returned an incomplete repository binding.");
  }
  return {
    provider: "github",
    owner: row.repository_owner,
    name: row.repository_name,
    defaultBranch: row.repository_default_branch,
  };
}

function inviteFromRow(row: InviteRow): InviteMetadata {
  if (row.role !== "member") throw new Error("PostgreSQL returned an invalid invite role.");
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    role: "member",
    createdByUserId: row.created_by_user_id,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

export class PostgresControlPlaneRepository implements ControlPlaneRepository {
  readonly #pool: Pool;
  readonly #clock: () => Date;
  readonly #idFactory: () => string;
  readonly #maxMembers: number;
  readonly #maxActiveInvites: number;

  constructor(pool: Pool, options: PostgresRepositoryOptions = {}) {
    this.#pool = pool;
    this.#clock = options.clock ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#maxMembers = options.maxMembers ?? MAX_WORKSPACE_MEMBERS;
    this.#maxActiveInvites = options.maxActiveInvites ?? MAX_ACTIVE_INVITES;
    if (!Number.isSafeInteger(this.#maxMembers) || this.#maxMembers < 1) {
      throw new Error("The PostgreSQL member limit is invalid.");
    }
    if (!Number.isSafeInteger(this.#maxActiveInvites) || this.#maxActiveInvites < 1) {
      throw new Error("The PostgreSQL invite limit is invalid.");
    }
  }

  async health(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  createWorkspace(input: CreateWorkspaceInput) {
    return this.#transaction(async (client) => {
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
      await this.#upsertUser(client, input.actor, now);
      await client.query(
        `INSERT INTO workspaces
          (id, room_id, name, state, room_sequence, created_by_user_id, created_at,
           repository_provider, repository_owner, repository_name, repository_default_branch)
         VALUES ($1, $2, $3, 'created', 0, $4, $5, $6, $7, $8, $9)`,
        [
          workspace.id,
          workspace.roomId,
          workspace.name,
          workspace.createdByUserId,
          now,
          input.repository?.provider ?? null,
          input.repository?.owner ?? null,
          input.repository?.name ?? null,
          input.repository?.defaultBranch ?? null,
        ],
      );
      await client.query(
        `INSERT INTO workspace_members
          (member_id, workspace_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, 'owner', $4)`,
        [membership.memberId, workspace.id, membership.userId, now],
      );
      await client.query(
        `INSERT INTO control_records
          (workspace_id, resource_kind, resource_id, holder_user_id, version, fence, typing_count, typing_until)
         VALUES ($1, 'code', 'code', NULL, 0, 0, 0, NULL)`,
        [workspace.id],
      );
      return { workspace, membership };
    });
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | null> {
    const result = await this.#pool.query<WorkspaceRow>(
      `SELECT id, room_id, name, state, room_sequence, created_by_user_id, created_at
         FROM workspaces
        WHERE id = $1`,
      [workspaceId],
    );
    const row = result.rows[0];
    return row ? workspaceFromRow(row) : null;
  }

  async getMembership(workspaceId: string, userId: string): Promise<WorkspaceMember | null> {
    const result = await this.#pool.query<MemberRow>(
      `SELECT wm.member_id, wm.workspace_id, wm.user_id, u.display_name, wm.role, wm.joined_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
      [workspaceId, userId],
    );
    const row = result.rows[0];
    return row ? memberFromRow(row) : null;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace) {
      throw new RepositoryError("WORKSPACE_NOT_FOUND", "The workspace does not exist.");
    }
    const result = await this.#pool.query<MemberRow>(
      `SELECT wm.member_id, wm.workspace_id, wm.user_id, u.display_name, wm.role, wm.joined_at
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = $1
        ORDER BY CASE wm.role WHEN 'owner' THEN 0 ELSE 1 END, wm.joined_at, wm.user_id`,
      [workspaceId],
    );
    return result.rows.map(memberFromRow);
  }

  createInvite(input: CreateInviteInput): Promise<InviteMetadata> {
    return this.#transaction(async (client) => {
      assertInviteTokenHash(input.tokenHash);
      assertInviteLifetime(input.expiresInSeconds);
      const access = await client.query<{ role: string | null }>(
        `SELECT wm.role
           FROM workspaces w
           LEFT JOIN workspace_members wm
             ON wm.workspace_id = w.id AND wm.user_id = $2
          WHERE w.id = $1
          FOR UPDATE OF w`,
        [input.workspaceId, input.actor.userId],
      );
      const accessRow = access.rows[0];
      if (!accessRow) {
        throw new RepositoryError("WORKSPACE_NOT_FOUND", "The workspace does not exist.");
      }
      if (accessRow.role === null) {
        throw new RepositoryError("NOT_MEMBER", "The actor is not a workspace member.");
      }
      if (accessRow.role !== "owner") {
        throw new RepositoryError("ROLE_REQUIRED", "Workspace owner access is required.");
      }

      const now = this.#now();
      const active = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM workspace_invites
          WHERE workspace_id = $1 AND redeemed_at IS NULL AND expires_at > $2`,
        [input.workspaceId, now],
      );
      if (Number(active.rows[0]?.count ?? "0") >= this.#maxActiveInvites) {
        throw new RepositoryError("ACTIVE_INVITE_LIMIT", "The workspace has too many active invites.");
      }

      const expiresAt = new Date(Date.parse(now) + input.expiresInSeconds * 1_000).toISOString();
      try {
        const result = await client.query<InviteRow>(
          `INSERT INTO workspace_invites
            (id, workspace_id, token_hash, role, created_by_user_id, created_at, expires_at)
           VALUES ($1, $2, $3, 'member', $4, $5, $6)
           RETURNING id, workspace_id, role, created_by_user_id, created_at, expires_at, redeemed_at`,
          [
            this.#idFactory(),
            input.workspaceId,
            input.tokenHash,
            input.actor.userId,
            now,
            expiresAt,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("PostgreSQL did not return the created invite.");
        return inviteFromRow(row);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new RepositoryError("INVITE_TOKEN_COLLISION", "The invite token already exists.");
        }
        throw error;
      }
    });
  }

  redeemInvite(input: RedeemInviteInput): Promise<RedeemedInvite> {
    return this.#transaction(async (client) => {
      assertInviteTokenHash(input.tokenHash);
      const inviteResult = await client.query<InviteRow>(
        `SELECT id, workspace_id, role, created_by_user_id, created_at, expires_at, redeemed_at
           FROM workspace_invites
          WHERE token_hash = $1
          FOR UPDATE`,
        [input.tokenHash],
      );
      const invite = inviteResult.rows[0];
      const now = this.#now();
      if (
        !invite ||
        invite.redeemed_at !== null ||
        Date.parse(timestamp(invite.expires_at)) <= Date.parse(now)
      ) {
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }

      const workspaceLock = await client.query<WorkspaceRow>(
        `SELECT id, room_id, name, state, room_sequence, created_by_user_id, created_at
           FROM workspaces
          WHERE id = $1
          FOR UPDATE`,
        [invite.workspace_id],
      );
      const workspaceRow = workspaceLock.rows[0];
      if (!workspaceRow) {
        throw new RepositoryError("INVITE_UNAVAILABLE", "The invite cannot be redeemed.");
      }

      const existing = await client.query<{ role: WorkspaceRole }>(
        `SELECT role
           FROM workspace_members
          WHERE workspace_id = $1 AND user_id = $2`,
        [invite.workspace_id, input.actor.userId],
      );
      if (existing.rowCount && existing.rowCount > 0) {
        throw new RepositoryError("ALREADY_MEMBER", "The user is already a workspace member.");
      }

      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM workspace_members WHERE workspace_id = $1`,
        [invite.workspace_id],
      );
      if (Number(countResult.rows[0]?.count ?? "0") >= this.#maxMembers) {
        throw new RepositoryError("MEMBER_LIMIT", "The workspace has reached its member limit.");
      }

      await this.#upsertUser(client, input.actor, now);
      const memberResult = await client.query<MemberRow>(
        `INSERT INTO workspace_members (member_id, workspace_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, 'member', $4)
         RETURNING member_id, workspace_id, user_id,
           (SELECT display_name FROM users WHERE id = $3) AS display_name,
           role, joined_at`,
        [this.#idFactory(), invite.workspace_id, input.actor.userId, now],
      );
      await client.query(
        `UPDATE workspace_invites
            SET redeemed_at = $2, redeemed_by_user_id = $3
          WHERE id = $1`,
        [invite.id, now, input.actor.userId],
      );
      const memberRow = memberResult.rows[0];
      if (!memberRow) throw new Error("PostgreSQL did not return the redeemed membership.");
      return {
        workspace: workspaceFromRow(workspaceRow),
        membership: memberFromRow(memberRow),
      };
    });
  }

  async getRoomSnapshotState(workspaceId: string): Promise<RoomSnapshotState | null> {
    const bootstrap = await this.getWorkspaceBootstrapState(workspaceId);
    if (!bootstrap) return null;
    return { workspace: bootstrap.workspace, codeControl: bootstrap.codeControl };
  }

  async getWorkspaceBootstrapState(workspaceId: string): Promise<WorkspaceBootstrapState | null> {
    const result = await this.#pool.query<SnapshotRow>(
      `SELECT w.id, w.room_id, w.name, w.state, w.room_sequence,
              w.created_by_user_id, w.created_at,
              w.repository_provider, w.repository_owner, w.repository_name,
              w.repository_default_branch,
              c.holder_user_id, holder.member_id AS holder_member_id,
              c.holder_client_id, c.lease_expires_at, c.version AS control_version,
              c.fence AS control_fence, c.typing_count, c.typing_until
         FROM workspaces w
         JOIN control_records c
           ON c.workspace_id = w.id
          AND c.resource_kind = 'code'
          AND c.resource_id = 'code'
         LEFT JOIN workspace_members holder
           ON holder.workspace_id = c.workspace_id
          AND holder.user_id = c.holder_user_id
        WHERE w.id = $1`,
      [workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const codeControl: CodeControl = {
      resource: "code",
      holderUserId: row.holder_user_id,
      version: safeCounter(row.control_version, "control version"),
      fence: safeCounter(row.control_fence, "control fence"),
      typingCount: safeCounter(row.typing_count, "typing count"),
      typingUntil: nullableTimestamp(row.typing_until),
    };
    const writerControl: WorkspaceWriterControl = {
      resource: { kind: "workspace", channel: "editor" },
      ownerMemberId: row.holder_member_id,
      ownerClientId: row.holder_client_id,
      leaseExpiresAt: nullableTimestamp(row.lease_expires_at),
      version: codeControl.version,
      fence: codeControl.fence,
      typingCount: codeControl.typingCount,
      typingUntil: codeControl.typingUntil,
    };
    const members = await this.listMembers(workspaceId);
    return {
      workspace: workspaceFromRow(row),
      repository: repositoryBindingFromRow(row),
      members,
      codeControl,
      writerControl,
    };
  }

  async #upsertUser(client: PoolClient, actor: AuthenticatedActor, now: string): Promise<void> {
    await client.query(
      `INSERT INTO users (id, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO UPDATE
         SET display_name = EXCLUDED.display_name, updated_at = EXCLUDED.updated_at`,
      [actor.userId, actor.displayName, now],
    );
  }

  #now(): string {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("The PostgreSQL repository clock returned an invalid date.");
    }
    return value.toISOString();
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the operation error; the pool will discard a broken client.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
