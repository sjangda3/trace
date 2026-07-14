import type { RawResult } from "../editor/bridge";
import type {
  AnnotationMessage,
  CodeAnnotation,
  CollabCollaborationBridge,
  CollaborationAnnotationRequest,
  CollaborationApi,
  CollaborationEvent,
  CollaborationMember,
  CollaborationSnapshot,
  CollaborationWorkspaceRequest,
  CreateAnnotationRequest,
  MarkTypingRequest,
  ReleaseWriterControlRequest,
  ReplyAnnotationRequest,
  RequestWriterControlRequest,
  ResolveAnnotationRequest,
  WriterControl,
} from "./types";

export class CollaborationApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CollaborationApiError";
  }
}

function unwrap<T>(result: RawResult<T>): T {
  if (result.ok) return result.value;
  throw new CollaborationApiError(result.error.code, result.error.message);
}

class ElectronCollaborationApi implements CollaborationApi {
  readonly source = "electron" as const;

  constructor(private readonly bridge: CollabCollaborationBridge) {}

  async snapshot(request: CollaborationWorkspaceRequest) {
    return unwrap(await this.bridge.snapshot(request));
  }

  async createAnnotation(request: CreateAnnotationRequest) {
    return unwrap(await this.bridge.createAnnotation(request));
  }

  async replyAnnotation(request: ReplyAnnotationRequest) {
    return unwrap(await this.bridge.replyAnnotation(request));
  }

  async resolveAnnotation(request: ResolveAnnotationRequest) {
    return unwrap(await this.bridge.resolveAnnotation(request));
  }

  async requestWriterControl(request: RequestWriterControlRequest) {
    return unwrap(await this.bridge.requestWriterControl(request));
  }

  async releaseWriterControl(request: ReleaseWriterControlRequest) {
    return unwrap(await this.bridge.releaseWriterControl(request));
  }

  async markTyping(request: MarkTypingRequest) {
    return unwrap(await this.bridge.markTyping(request));
  }

  onDidChange(callback: (event: CollaborationEvent) => void): () => void {
    const dispose = this.bridge.onDidChange(callback);
    return typeof dispose === "function" ? dispose : () => undefined;
  }
}

function unavailableSnapshot(workspaceId: string): CollaborationSnapshot {
  return {
    workspaceId,
    connection: "unavailable",
    syncStatus: "idle",
    members: [],
    annotations: [],
    writerControl: {
      mode: "blocked",
      ownerId: null,
      ownerName: null,
      ownerIsLocal: false,
      typingCount: 0,
      requestable: false,
      requestedByLocal: false,
      version: 0,
      fence: 0,
    },
    pendingOperations: 0,
    lastSyncedAt: null,
    message: "Collaboration is not connected in this build.",
  };
}

class UnavailableCollaborationApi implements CollaborationApi {
  readonly source = "unavailable" as const;

  async snapshot(request: CollaborationWorkspaceRequest): Promise<CollaborationSnapshot> {
    return unavailableSnapshot(request.workspaceId);
  }

  private unavailable(): never {
    throw new CollaborationApiError(
      "COLLABORATION_UNAVAILABLE",
      "Collaboration is not connected in this build.",
    );
  }

  async createAnnotation(_request: CreateAnnotationRequest): Promise<CodeAnnotation> {
    return this.unavailable();
  }

  async replyAnnotation(_request: ReplyAnnotationRequest): Promise<CodeAnnotation> {
    return this.unavailable();
  }

  async resolveAnnotation(_request: ResolveAnnotationRequest): Promise<CodeAnnotation> {
    return this.unavailable();
  }

  async requestWriterControl(_request: RequestWriterControlRequest): Promise<WriterControl> {
    return this.unavailable();
  }

  async releaseWriterControl(_request: ReleaseWriterControlRequest): Promise<WriterControl> {
    return this.unavailable();
  }

  async markTyping(_request: MarkTypingRequest): Promise<WriterControl> {
    return this.unavailable();
  }

  onDidChange(_callback: (event: CollaborationEvent) => void): () => void {
    return () => undefined;
  }
}

export type DemoCollaborationOptions = {
  localName?: string;
  members?: CollaborationMember[];
  annotations?: CodeAnnotation[];
};

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

/**
 * An explicit, in-memory implementation for visual QA and stories. It never opens
 * sockets or persists collaboration data and is not selected by default.
 */
export class DemoCollaborationApi implements CollaborationApi {
  readonly source = "demo" as const;
  private readonly snapshots = new Map<string, CollaborationSnapshot>();
  private readonly listeners = new Set<(event: CollaborationEvent) => void>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: DemoCollaborationOptions = {}) {}

  async snapshot(request: CollaborationWorkspaceRequest): Promise<CollaborationSnapshot> {
    return this.clone(this.requireSnapshot(request.workspaceId));
  }

  async createAnnotation(request: CreateAnnotationRequest): Promise<CodeAnnotation> {
    const snapshot = this.requireSnapshot(request.workspaceId);
    const createdAt = nowIso();
    const message: AnnotationMessage = {
      id: randomId("message"),
      author: this.localMember(snapshot),
      body: request.body,
      createdAt,
      updatedAt: null,
      syncStatus: "synced",
    };
    const annotation: CodeAnnotation = {
      id: randomId("annotation"),
      workspaceId: request.workspaceId,
      anchor: { ...request.anchor },
      status: "open",
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      resolvedBy: null,
      messages: [message],
    };
    snapshot.annotations.unshift(annotation);
    snapshot.lastSyncedAt = createdAt;
    this.emit(snapshot, "annotations");
    return this.clone(annotation);
  }

  async replyAnnotation(request: ReplyAnnotationRequest): Promise<CodeAnnotation> {
    const { snapshot, annotation } = this.requireAnnotation(request);
    const createdAt = nowIso();
    annotation.messages.push({
      id: randomId("message"),
      author: this.localMember(snapshot),
      body: request.body,
      createdAt,
      updatedAt: null,
      syncStatus: "synced",
    });
    annotation.updatedAt = createdAt;
    snapshot.lastSyncedAt = createdAt;
    this.emit(snapshot, "annotations");
    return this.clone(annotation);
  }

  async resolveAnnotation(request: ResolveAnnotationRequest): Promise<CodeAnnotation> {
    const { snapshot, annotation } = this.requireAnnotation(request);
    const changedAt = nowIso();
    annotation.status = request.resolved ? "resolved" : "open";
    annotation.resolvedAt = request.resolved ? changedAt : null;
    annotation.resolvedBy = request.resolved ? this.localMember(snapshot) : null;
    annotation.updatedAt = changedAt;
    snapshot.lastSyncedAt = changedAt;
    this.emit(snapshot, "annotations");
    return this.clone(annotation);
  }

  async requestWriterControl(request: RequestWriterControlRequest): Promise<WriterControl> {
    const snapshot = this.requireSnapshot(request.workspaceId);
    if (snapshot.writerControl.version !== request.expectedVersion) {
      throw new CollaborationApiError("CONTROL_CHANGED", "Editor control changed before the request could be applied.");
    }
    if (snapshot.writerControl.ownerIsLocal) return this.clone(snapshot.writerControl);
    if (snapshot.writerControl.typingCount > 0 || !snapshot.writerControl.requestable) {
      throw new CollaborationApiError(
        "WRITER_BUSY",
        "Control becomes available when everyone has stopped typing.",
      );
    }
    const local = this.localMember(snapshot);
    snapshot.writerControl = {
      mode: "held",
      ownerId: local.id,
      ownerName: local.displayName,
      ownerIsLocal: true,
      typingCount: 0,
      requestable: true,
      requestedByLocal: false,
      version: snapshot.writerControl.version + 1,
      fence: snapshot.writerControl.fence + 1,
    };
    this.emit(snapshot, "control");
    return this.clone(snapshot.writerControl);
  }

  async releaseWriterControl(request: ReleaseWriterControlRequest): Promise<WriterControl> {
    const snapshot = this.requireSnapshot(request.workspaceId);
    if (
      snapshot.writerControl.version !== request.expectedVersion ||
      snapshot.writerControl.fence !== request.expectedFence
    ) {
      throw new CollaborationApiError("CONTROL_CHANGED", "Editor control changed before the request could be applied.");
    }
    if (!snapshot.writerControl.ownerIsLocal) {
      throw new CollaborationApiError("NOT_CONTROL_OWNER", "Only the current writer can release control.");
    }
    if (snapshot.writerControl.typingCount > 0) {
      throw new CollaborationApiError("CONTROL_BUSY", "Control can only change hands after everyone has stopped typing.");
    }
    snapshot.writerControl = {
      mode: "available",
      ownerId: null,
      ownerName: null,
      ownerIsLocal: false,
      typingCount: 0,
      requestable: true,
      requestedByLocal: false,
      version: snapshot.writerControl.version + 1,
      fence: snapshot.writerControl.fence + 1,
    };
    this.emit(snapshot, "control");
    return this.clone(snapshot.writerControl);
  }

  async markTyping(request: MarkTypingRequest): Promise<WriterControl> {
    const snapshot = this.requireSnapshot(request.workspaceId);
    if (snapshot.writerControl.fence !== request.expectedFence) {
      throw new CollaborationApiError("CONTROL_CHANGED", "Editor control changed before the edit could be applied.");
    }
    if (!snapshot.writerControl.ownerIsLocal) {
      throw new CollaborationApiError("NOT_CONTROL_OWNER", "Take control before editing.");
    }
    const beganTyping = snapshot.writerControl.typingCount === 0;
    snapshot.writerControl.typingCount = 1;
    if (beganTyping) snapshot.writerControl.version += 1;
    const previousTimer = this.typingTimers.get(request.workspaceId);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      this.typingTimers.delete(request.workspaceId);
      const current = this.snapshots.get(request.workspaceId);
      if (!current || current.writerControl.fence !== request.expectedFence) return;
      if (current.writerControl.typingCount > 0) {
        current.writerControl.typingCount = 0;
        current.writerControl.version += 1;
        this.emit(current, "control");
      }
    }, 900);
    this.typingTimers.set(request.workspaceId, timer);
    if (beganTyping) this.emit(snapshot, "control");
    return this.clone(snapshot.writerControl);
  }

  onDidChange(callback: (event: CollaborationEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private requireSnapshot(workspaceId: string): CollaborationSnapshot {
    const current = this.snapshots.get(workspaceId);
    if (current) return current;

    const localName = this.options.localName?.trim() || "You";
    const local: CollaborationMember = {
      id: "local",
      displayName: localName,
      handle: null,
      initials: localName.slice(0, 2).toLocaleUpperCase(),
      accent: "blue",
      presence: "active",
      isLocal: true,
      isTyping: false,
      activePath: null,
      lastSeenAt: null,
    };
    const members = this.options.members?.length ? this.options.members.map((member) => ({ ...member })) : [local];
    if (!members.some((member) => member.isLocal)) members.unshift(local);
    const snapshot: CollaborationSnapshot = {
      workspaceId,
      connection: "online",
      syncStatus: "idle",
      members,
      annotations: (this.options.annotations ?? []).map((annotation) => ({
        ...this.clone(annotation),
        workspaceId,
      })),
      writerControl: {
        mode: "available",
        ownerId: null,
        ownerName: null,
        ownerIsLocal: false,
        typingCount: 0,
        requestable: true,
        requestedByLocal: false,
        version: 0,
        fence: 0,
      },
      pendingOperations: 0,
      lastSyncedAt: nowIso(),
      message: null,
    };
    this.snapshots.set(workspaceId, snapshot);
    return snapshot;
  }

  private localMember(snapshot: CollaborationSnapshot) {
    const member = snapshot.members.find((candidate) => candidate.isLocal);
    if (!member) throw new CollaborationApiError("LOCAL_MEMBER_MISSING", "The local member is unavailable.");
    return this.clone(member);
  }

  private requireAnnotation(request: CollaborationAnnotationRequest) {
    const snapshot = this.requireSnapshot(request.workspaceId);
    const annotation = snapshot.annotations.find((candidate) => candidate.id === request.annotationId);
    if (!annotation) throw new CollaborationApiError("ANNOTATION_NOT_FOUND", "The annotation no longer exists.");
    return { snapshot, annotation };
  }

  private emit(snapshot: CollaborationSnapshot, reason: CollaborationEvent["reason"]) {
    const event: CollaborationEvent = {
      workspaceId: snapshot.workspaceId,
      reason,
      snapshot: this.clone(snapshot),
      timestamp: Date.now(),
    };
    for (const listener of this.listeners) listener(event);
  }

  private clone<T>(value: T): T {
    return globalThis.structuredClone(value);
  }
}

export type CollaborationFallback = "unavailable" | "demo";

export function createCollaborationApi(
  bridge?: CollabCollaborationBridge,
  fallback: CollaborationFallback = "unavailable",
): CollaborationApi {
  const nativeBridge = bridge ?? (typeof window !== "undefined" ? window.collabCollaboration : undefined);
  if (nativeBridge) return new ElectronCollaborationApi(nativeBridge);
  return fallback === "demo" ? new DemoCollaborationApi() : new UnavailableCollaborationApi();
}

export const collaborationApi = createCollaborationApi();
