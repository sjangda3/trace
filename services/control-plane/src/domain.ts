export type WorkspaceRole = "owner" | "member";
export type WorkspaceState = "created";

export type AuthenticatedActor = {
  userId: string;
  displayName: string;
};

export type RepositoryBinding = {
  provider: "github";
  owner: string;
  name: string;
  defaultBranch: string;
};

export type Workspace = {
  id: string;
  roomId: string;
  name: string;
  state: WorkspaceState;
  roomSequence: number;
  createdByUserId: string;
  createdAt: string;
};

export type WorkspaceMember = {
  /** Stable room identity; intentionally distinct from account identity. */
  memberId: string;
  workspaceId: string;
  userId: string;
  displayName: string;
  role: WorkspaceRole;
  joinedAt: string;
};

export type InviteMetadata = {
  id: string;
  workspaceId: string;
  role: "member";
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
};

export type CodeControl = {
  resource: "code";
  holderUserId: string | null;
  version: number;
  fence: number;
  typingCount: number;
  typingUntil: string | null;
};

export type WorkspaceWriterControl = {
  resource: { kind: "workspace"; channel: "editor" };
  ownerMemberId: string | null;
  ownerClientId: string | null;
  leaseExpiresAt: string | null;
  version: number;
  fence: number;
  typingCount: number;
  typingUntil: string | null;
};

/**
 * Server-side bootstrap material. The REST route intentionally projects the
 * legacy workspace/member/code-control response rather than exposing this
 * object or a collaboration-protocol envelope directly.
 */
export type WorkspaceBootstrapState = {
  workspace: Workspace;
  repository: RepositoryBinding | null;
  members: WorkspaceMember[];
  codeControl: CodeControl;
  writerControl: WorkspaceWriterControl;
};

/** @deprecated Use WorkspaceBootstrapState for the REST bootstrap boundary. */
export type RoomSnapshotState = Pick<WorkspaceBootstrapState, "workspace" | "codeControl">;

export type RedeemedInvite = {
  workspace: Workspace;
  membership: WorkspaceMember;
};
