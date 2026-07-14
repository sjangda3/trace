import type { RawResult } from "../editor/bridge";

export type CollaborationConnectionStatus =
  | "unavailable"
  | "connecting"
  | "online"
  | "syncing"
  | "offline"
  | "error";

export type CollaborationSyncStatus =
  | "idle"
  | "syncing"
  | "pending"
  | "conflict"
  | "offline";

export type MemberPresenceStatus = "active" | "idle" | "offline";

/** A finite palette prevents bridge-provided values from becoming arbitrary CSS. */
export type MemberAccent = "blue" | "violet" | "green" | "amber" | "rose" | "slate";

export type CollaborationMember = {
  id: string;
  displayName: string;
  handle: string | null;
  initials: string;
  accent: MemberAccent;
  presence: MemberPresenceStatus;
  isLocal: boolean;
  isTyping: boolean;
  activePath: string | null;
  lastSeenAt: string | null;
};

export type WriterControlMode = "available" | "held" | "waiting" | "blocked";

export type WriterControl = {
  mode: WriterControlMode;
  ownerId: string | null;
  ownerName: string | null;
  ownerIsLocal: boolean;
  typingCount: number;
  requestable: boolean;
  requestedByLocal: boolean;
  version: number;
  fence: number;
};

export type AnnotationAnchor = {
  path: string;
  startLine: number;
  endLine: number;
  revision: string | null;
  contentHash: string | null;
};

export type AnnotationSyncStatus = "synced" | "pending" | "failed";
export type AnnotationStatus = "open" | "resolved";

export type AnnotationMessage = {
  id: string;
  author: CollaborationMember;
  body: string;
  createdAt: string;
  updatedAt: string | null;
  syncStatus: AnnotationSyncStatus;
};

export type CodeAnnotation = {
  id: string;
  workspaceId: string;
  anchor: AnnotationAnchor;
  status: AnnotationStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolvedBy: CollaborationMember | null;
  messages: AnnotationMessage[];
};

export type CollaborationSnapshot = {
  workspaceId: string;
  connection: CollaborationConnectionStatus;
  syncStatus: CollaborationSyncStatus;
  members: CollaborationMember[];
  annotations: CodeAnnotation[];
  writerControl: WriterControl;
  pendingOperations: number;
  lastSyncedAt: string | null;
  message: string | null;
};

export type CollaborationWorkspaceRequest = { workspaceId: string };
export type RequestWriterControlRequest = CollaborationWorkspaceRequest & { expectedVersion: number };
export type ReleaseWriterControlRequest = CollaborationWorkspaceRequest & {
  expectedVersion: number;
  expectedFence: number;
};
export type MarkTypingRequest = CollaborationWorkspaceRequest & { expectedFence: number };
export type CollaborationAnnotationRequest = CollaborationWorkspaceRequest & { annotationId: string };
export type CreateAnnotationRequest = CollaborationWorkspaceRequest & {
  anchor: AnnotationAnchor;
  body: string;
};
export type ReplyAnnotationRequest = CollaborationAnnotationRequest & { body: string };
export type ResolveAnnotationRequest = CollaborationAnnotationRequest & { resolved: boolean };

export type CollaborationEvent = {
  workspaceId: string;
  reason: "snapshot" | "presence" | "annotations" | "control" | "sync";
  snapshot: CollaborationSnapshot | null;
  timestamp: number;
};

export interface CollabCollaborationBridge {
  snapshot(request: CollaborationWorkspaceRequest): Promise<RawResult<CollaborationSnapshot>>;
  createAnnotation(request: CreateAnnotationRequest): Promise<RawResult<CodeAnnotation>>;
  replyAnnotation(request: ReplyAnnotationRequest): Promise<RawResult<CodeAnnotation>>;
  resolveAnnotation(request: ResolveAnnotationRequest): Promise<RawResult<CodeAnnotation>>;
  requestWriterControl(request: RequestWriterControlRequest): Promise<RawResult<WriterControl>>;
  releaseWriterControl(request: ReleaseWriterControlRequest): Promise<RawResult<WriterControl>>;
  markTyping(request: MarkTypingRequest): Promise<RawResult<WriterControl>>;
  onDidChange(callback: (event: CollaborationEvent) => void): (() => void) | void;
}

export interface CollaborationApi {
  readonly source: "electron" | "unavailable" | "demo";
  snapshot(request: CollaborationWorkspaceRequest): Promise<CollaborationSnapshot>;
  createAnnotation(request: CreateAnnotationRequest): Promise<CodeAnnotation>;
  replyAnnotation(request: ReplyAnnotationRequest): Promise<CodeAnnotation>;
  resolveAnnotation(request: ResolveAnnotationRequest): Promise<CodeAnnotation>;
  requestWriterControl(request: RequestWriterControlRequest): Promise<WriterControl>;
  releaseWriterControl(request: ReleaseWriterControlRequest): Promise<WriterControl>;
  markTyping(request: MarkTypingRequest): Promise<WriterControl>;
  onDidChange(callback: (event: CollaborationEvent) => void): () => void;
}

declare global {
  interface Window {
    collabCollaboration?: CollabCollaborationBridge;
  }
}
