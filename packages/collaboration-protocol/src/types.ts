export const PROTOCOL_VERSION = "1.0" as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const;
export const WRITER_TYPING_IDLE_MS = 900 as const;

export const PROTOCOL_LIMITS = Object.freeze({
  maxFrameBytes: 1_500_000,
  maxContextBytes: 16 * 1024,
  maxReplyBytes: 4 * 1024,
  maxRecoveryDraftBytes: 1024 * 1024,
  maxTerminalInputBytes: 64 * 1024,
  maxAnnotationsPerSnapshot: 1_000,
  maxMembersPerRoom: 100,
  maxPresenceEntries: 200,
  maxWriterControls: 256,
  maxRecoveryDraftsPerSnapshot: 64,
  maxAnnotationReplies: 64,
  maxValidationIssues: 32,
  maxReplayEvents: 500,
});

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type IsoTimestamp = string;
export type GitOid = string;
export type Sha256 = string;
export type ReplayCursor = string;

export type MemberRole = "owner" | "maintainer" | "member" | "guest";
export type PresenceStatus = "active" | "idle" | "offline";
export type DeliveryClass = "durable" | "ephemeral";
export type QueuePolicy = "offline_allowed" | "never";

export interface CodeRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface GitHubLink {
  kind: "issue" | "pull_request";
  owner: string;
  repository: string;
  number: number;
  commentId: string | null;
  reviewThreadId: string | null;
}

export interface AnnotationReply {
  id: string;
  context: string;
  authorMemberId: string;
  authorDisplayName: string;
  createdAt: IsoTimestamp;
}

export interface Annotation {
  id: string;
  filePath: string;
  context: string;
  range: CodeRange;
  authorMemberId: string;
  authorDisplayName: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  updatedByMemberId: string;
  resolved: boolean;
  resolvedAt: IsoTimestamp | null;
  resolvedByMemberId: string | null;
  githubLink: GitHubLink | null;
  anchorRevision: GitOid | null;
  anchorContentHash: Sha256 | null;
  replies: AnnotationReply[];
  revision: number;
}

export interface AnnotationTombstone {
  id: string;
  filePath: string;
  githubLink: GitHubLink | null;
  anchorRevision: GitOid | null;
  anchorContentHash: Sha256 | null;
  deletedAt: IsoTimestamp;
  deletedByMemberId: string;
  revision: number;
}

export interface RepositoryRef {
  provider: "github";
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface RoomMember {
  memberId: string;
  displayName: string;
  role: MemberRole;
  joinedAt: IsoTimestamp;
}

export interface PresenceState {
  memberId: string;
  clientId: string;
  status: PresenceStatus;
  activePath: string | null;
  cursor: CodeRange | null;
  typing: boolean;
  lastSeenAt: IsoTimestamp;
}

export type WriterResource =
  | { kind: "workspace"; channel: "editor" }
  | { kind: "editor"; filePath: string }
  | { kind: "terminal"; sessionId: string };

export interface WriterControlState {
  resource: WriterResource;
  version: number;
  fence: number;
  ownerMemberId: string | null;
  ownerClientId: string | null;
  leaseExpiresAt: IsoTimestamp | null;
  typingCount: number;
  typingUntil: IsoTimestamp | null;
}

export interface RecoveryDraftSummary {
  draftId: string;
  filePath: string;
  baseRevision: GitOid | null;
  contentSha256: string;
  sizeBytes: number;
  authorMemberId: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface RecoveryDraft extends RecoveryDraftSummary {
  encoding: "utf8";
  content: string;
}

export type RecoveryDraftInput = Omit<RecoveryDraft, "authorMemberId">;

export interface RoomSnapshot {
  roomId: string;
  snapshotVersion: number;
  generatedAt: IsoTimestamp;
  repository: RepositoryRef;
  members: RoomMember[];
  presence: PresenceState[];
  annotations: Annotation[];
  writerControls: WriterControlState[];
  recoveryDrafts: RecoveryDraftSummary[];
}

export interface ProtocolClientHello {
  kind: "protocol.hello";
  supportedVersions: string[];
  clientInstanceId: string;
  appVersion: string;
  platform: "macos" | "windows" | "linux";
  resume: { roomId: string; cursor: ReplayCursor } | null;
}

export interface ProtocolServerAccept {
  kind: "protocol.accept";
  version: ProtocolVersion;
  connectionId: string;
  serverTime: IsoTimestamp;
  heartbeatMs: number;
  maxFrameBytes: number;
  resumeStatus: "not_requested" | "accepted" | "snapshot_required";
}

export interface ProtocolServerReject {
  kind: "protocol.reject";
  code: "VERSION_UNSUPPORTED" | "AUTH_REQUIRED" | "ROOM_UNAVAILABLE" | "RATE_LIMITED";
  message: string;
  supportedVersions: string[];
  retryAfterMs: number | null;
}

export interface ReplayRequest {
  kind: "replay.request";
  protocolVersion: ProtocolVersion;
  roomId: string;
  afterCursor: ReplayCursor;
  limit: number;
}

interface DurableQueuedCommand {
  delivery: "durable";
  queuePolicy: "offline_allowed";
}

interface EphemeralCommand {
  delivery: "ephemeral";
  queuePolicy: "never";
}

export interface PresencePublishCommand extends EphemeralCommand {
  type: "presence.publish";
  status: Exclude<PresenceStatus, "offline">;
  activePath: string | null;
  cursor: CodeRange | null;
  typing: boolean;
}

export interface AnnotationCreateMutation extends DurableQueuedCommand {
  type: "annotation.create";
  mutationId: string;
  annotationId: string;
  filePath: string;
  context: string;
  range: CodeRange;
  githubLink: GitHubLink | null;
  anchorRevision: GitOid | null;
  anchorContentHash: Sha256 | null;
  createdAt: IsoTimestamp;
}

export interface AnnotationUpdateMutation extends DurableQueuedCommand {
  type: "annotation.update";
  mutationId: string;
  annotationId: string;
  expectedRevision: number;
  patch: {
    context?: string;
    range?: CodeRange;
    githubLink?: GitHubLink | null;
    anchorRevision?: GitOid | null;
    anchorContentHash?: Sha256 | null;
  };
}

export interface AnnotationReplyMutation extends DurableQueuedCommand {
  type: "annotation.reply";
  mutationId: string;
  annotationId: string;
  expectedRevision: number;
  replyId: string;
  context: string;
  createdAt: IsoTimestamp;
}

export interface AnnotationResolveMutation extends DurableQueuedCommand {
  type: "annotation.resolve";
  mutationId: string;
  annotationId: string;
  expectedRevision: number;
  resolved: boolean;
}

export interface AnnotationDeleteMutation extends DurableQueuedCommand {
  type: "annotation.delete";
  mutationId: string;
  annotationId: string;
  expectedRevision: number;
}

export type AnnotationMutation =
  | AnnotationCreateMutation
  | AnnotationUpdateMutation
  | AnnotationReplyMutation
  | AnnotationResolveMutation
  | AnnotationDeleteMutation;

interface WriterControlCasBase extends EphemeralCommand {
  type: "writer.control.cas";
  resource: WriterResource;
  expectedVersion: number;
  expectedFence: number;
}

export type WriterControlCasCommand = WriterControlCasBase & (
  | { desiredOwnerClientId: string; leaseMs: number }
  | { desiredOwnerClientId: null; leaseMs: 0 }
);

export interface RecoveryDraftPutMutation extends DurableQueuedCommand {
  type: "recovery.draft.put";
  mutationId: string;
  draft: RecoveryDraftInput;
}

export interface RecoveryDraftDeleteMutation extends DurableQueuedCommand {
  type: "recovery.draft.delete";
  mutationId: string;
  draftId: string;
  expectedUpdatedAt: IsoTimestamp;
}

export type RecoveryDraftMutation = RecoveryDraftPutMutation | RecoveryDraftDeleteMutation;

export interface TerminalControlCommand extends EphemeralCommand {
  type: "terminal.control";
  sessionId: string;
  action: "request" | "release";
  expectedVersion: number;
  expectedFence: number;
}

export interface TerminalInputCommand extends EphemeralCommand {
  type: "terminal.input";
  sessionId: string;
  inputSequence: number;
  fence: number;
  encoding: "utf8";
  data: string;
}

export type CommandPayload =
  | PresencePublishCommand
  | AnnotationMutation
  | WriterControlCasCommand
  | RecoveryDraftMutation
  | TerminalControlCommand
  | TerminalInputCommand;

export interface CommandEnvelope<T extends CommandPayload = CommandPayload> {
  kind: "command";
  protocolVersion: ProtocolVersion;
  roomId: string;
  requestId: string;
  sentAt: IsoTimestamp;
  payload: T;
}

export interface ProtocolError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface PresenceChangedEvent {
  type: "presence.changed";
  presence: PresenceState;
}

export type AnnotationMutationAck =
  | {
      type: "annotation.ack";
      requestId: string;
      mutationId: string;
      status: "applied" | "duplicate";
      annotationId: string;
      appliedRevision: number;
      error: null;
    }
  | {
      type: "annotation.ack";
      requestId: string;
      mutationId: string;
      status: "conflict" | "rejected";
      annotationId: string;
      appliedRevision: number | null;
      error: ProtocolError;
    };

export type AnnotationChangedEvent =
  | {
      type: "annotation.changed";
      mutationId: string;
      operation: "create" | "update" | "reply" | "resolve";
      annotation: Annotation;
      tombstone: null;
    }
  | {
      type: "annotation.changed";
      mutationId: string;
      operation: "delete";
      annotation: null;
      tombstone: AnnotationTombstone;
    };

export type WriterControlAck =
  | {
      type: "writer.control.ack";
      requestId: string;
      status: "applied";
      state: WriterControlState;
      error: null;
    }
  | {
      type: "writer.control.ack";
      requestId: string;
      status: "compare_failed" | "denied";
      state: WriterControlState;
      error: ProtocolError;
    };

export interface WriterControlChangedEvent {
  type: "writer.control.changed";
  state: WriterControlState;
  previousFence: number;
  reason: "acquired" | "released" | "expired" | "revoked" | "disconnected";
}

export interface WriterFenceAdvancedEvent {
  type: "writer.fence.advanced";
  resource: WriterResource;
  version: number;
  previousFence: number;
  fence: number;
  revokedClientId: string | null;
  reason: "release" | "expiry" | "revocation" | "disconnect";
}

export type RecoveryDraftAck =
  | {
      type: "recovery.ack";
      requestId: string;
      mutationId: string;
      status: "applied" | "duplicate";
      draftId: string;
      updatedAt: IsoTimestamp;
      error: null;
    }
  | {
      type: "recovery.ack";
      requestId: string;
      mutationId: string;
      status: "conflict" | "rejected";
      draftId: string;
      updatedAt: IsoTimestamp | null;
      error: ProtocolError;
    };

export type RecoveryDraftChangedEvent =
  | {
      type: "recovery.draft.changed";
      mutationId: string;
      operation: "put";
      draft: RecoveryDraftSummary;
      deletedDraftId: null;
    }
  | {
      type: "recovery.draft.changed";
      mutationId: string;
      operation: "delete";
      draft: null;
      deletedDraftId: string;
    };

export type TerminalControlAck =
  | {
      type: "terminal.control.ack";
      requestId: string;
      status: "applied";
      state: WriterControlState;
      error: null;
    }
  | {
      type: "terminal.control.ack";
      requestId: string;
      status: "compare_failed" | "denied" | "session_missing";
      state: WriterControlState | null;
      error: ProtocolError;
    };

export interface TerminalInputRejectedEvent {
  type: "terminal.input.rejected";
  requestId: string;
  sessionId: string;
  inputSequence: number;
  currentFence: number | null;
  error: ProtocolError;
}

export type EventPayload =
  | PresenceChangedEvent
  | AnnotationMutationAck
  | AnnotationChangedEvent
  | WriterControlAck
  | WriterControlChangedEvent
  | WriterFenceAdvancedEvent
  | RecoveryDraftAck
  | RecoveryDraftChangedEvent
  | TerminalControlAck
  | TerminalInputRejectedEvent;

interface EventEnvelopeBase<T extends EventPayload> {
  kind: "event";
  protocolVersion: ProtocolVersion;
  roomId: string;
  eventId: string;
  emittedAt: IsoTimestamp;
  payload: T;
}

export interface DurableEventEnvelope<T extends EventPayload = EventPayload> extends EventEnvelopeBase<T> {
  stream: "durable";
  sequence: number;
  cursor: ReplayCursor;
  previousCursor: ReplayCursor | null;
}

export interface EphemeralEventEnvelope<T extends EventPayload = EventPayload> extends EventEnvelopeBase<T> {
  stream: "ephemeral";
  sequence: null;
  cursor: null;
  previousCursor: null;
}

export type EventEnvelope<T extends EventPayload = EventPayload> =
  | DurableEventEnvelope<T>
  | EphemeralEventEnvelope<T>;

export interface SnapshotEnvelope {
  kind: "snapshot";
  protocolVersion: ProtocolVersion;
  roomId: string;
  sequence: number;
  cursor: ReplayCursor;
  emittedAt: IsoTimestamp;
  snapshot: RoomSnapshot;
}

export type NegotiationMessage = ProtocolClientHello | ProtocolServerAccept | ProtocolServerReject;
export type WireMessage =
  | NegotiationMessage
  | ReplayRequest
  | CommandEnvelope
  | EventEnvelope
  | SnapshotEnvelope;

export interface ValidationIssue {
  instancePath: string;
  keyword: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };
