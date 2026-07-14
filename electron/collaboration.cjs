const crypto = require("node:crypto");
const { WorkspaceError } = require("./workspace.cjs");
const { ExclusiveControl, ExclusiveControlError } = require("./exclusive-control.cjs");

const LOCAL_MEMBER = Object.freeze({ id: "local", name: "You" });
const MAX_SNAPSHOT_ANNOTATIONS = 100;

function invalidRequest(message = "The collaboration request is invalid.") {
  return new WorkspaceError("INVALID_REQUEST", message);
}

function requireWorkspaceRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw invalidRequest();
  if (
    typeof request.workspaceId !== "string" ||
    request.workspaceId.length === 0 ||
    request.workspaceId.includes("\0")
  ) {
    throw invalidRequest("The collaboration request is missing its workspace identity.");
  }
  return request.workspaceId;
}

function requireExpectedCounter(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidRequest(`The expected control ${label} is invalid.`);
  }
  return value;
}

function initials(displayName) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : displayName.slice(0, 2))
    .toLocaleUpperCase();
}

function member(memberId, displayName, localMember) {
  const isLocal = memberId === localMember.id;
  const name = isLocal ? localMember.name : displayName || "Workspace member";
  return {
    id: memberId,
    displayName: name,
    handle: null,
    initials: initials(name),
    accent: isLocal ? "blue" : "slate",
    presence: isLocal ? "active" : "offline",
    isLocal,
    isTyping: false,
    activePath: null,
    lastSeenAt: null,
  };
}

function mapAnnotation(annotation, workspaceId, localMember, pendingAnnotationIds) {
  const author = member(
    annotation.authorMemberId,
    annotation.authorDisplayName,
    localMember,
  );
  const pending = pendingAnnotationIds.has(annotation.id) ? "pending" : "synced";
  const messages = [{
    id: `${annotation.id}:root`,
    author,
    body: annotation.context,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt === annotation.createdAt ? null : annotation.updatedAt,
    syncStatus: pending,
  }, ...annotation.replies.map((reply) => ({
    id: reply.id,
    author: member(reply.authorMemberId, reply.authorDisplayName, localMember),
    body: reply.context,
    createdAt: reply.createdAt,
    updatedAt: null,
    syncStatus: pending,
  }))];

  return {
    id: annotation.id,
    workspaceId,
    anchor: {
      path: annotation.filePath,
      startLine: annotation.range.startLine,
      endLine: annotation.range.endLine,
      revision: annotation.anchorRevision ?? null,
      contentHash: annotation.anchorContentHash ?? null,
    },
    status: annotation.resolved ? "resolved" : "open",
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    resolvedAt: annotation.resolvedAt,
    resolvedBy: annotation.resolvedByMemberId
      ? member(annotation.resolvedByMemberId, null, localMember)
      : null,
    messages,
  };
}

function controlError(error) {
  if (error instanceof ExclusiveControlError) {
    return new WorkspaceError(error.code, error.message);
  }
  return error;
}

class CollaborationManager {
  #annotationManager;
  #localMember;
  #controls = new Map();
  #operationQueues = new Map();
  #listeners = new Set();

  constructor({ annotationManager, localMember = LOCAL_MEMBER } = {}) {
    if (!annotationManager || typeof annotationManager.listAnnotations !== "function") {
      throw new TypeError("CollaborationManager requires an annotation manager.");
    }
    if (
      !localMember ||
      typeof localMember.id !== "string" ||
      !localMember.id ||
      typeof localMember.name !== "string" ||
      !localMember.name
    ) {
      throw new TypeError("CollaborationManager requires a local member.");
    }
    this.#annotationManager = annotationManager;
    this.#localMember = Object.freeze({ id: localMember.id, name: localMember.name });
  }

  onDidChange(listener) {
    if (typeof listener !== "function") throw new TypeError("A collaboration listener is required.");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async snapshot(request = {}) {
    const workspaceId = requireWorkspaceRequest(request);
    const [page, outbox] = await Promise.all([
      this.#annotationManager.listAnnotations({
        workspaceId,
        includeResolved: true,
        limit: MAX_SNAPSHOT_ANNOTATIONS,
      }),
      this.#annotationManager.listPendingMutations({
        workspaceId,
        limit: MAX_SNAPSHOT_ANNOTATIONS,
      }),
    ]);
    const pendingAnnotationIds = new Set(outbox.items.map((entry) => entry.annotationId));
    if (outbox.nextSequence !== null) {
      for (const annotation of page.items) pendingAnnotationIds.add(annotation.id);
    }
    const local = member(this.#localMember.id, this.#localMember.name, this.#localMember);
    const pendingMutationCount = page.pendingMutationCount;
    return {
      workspaceId,
      connection: "offline",
      syncStatus: pendingMutationCount > 0 ? "offline" : "idle",
      members: [local],
      annotations: page.items.map((annotation) => (
        mapAnnotation(annotation, workspaceId, this.#localMember, pendingAnnotationIds)
      )),
      writerControl: this.#writerControl(workspaceId),
      pendingOperations: pendingMutationCount,
      lastSyncedAt: null,
      message: page.nextCursor
        ? "Showing the 100 most recently updated local annotations. Cloud sync is not connected."
        : "Annotations are saved locally. Cloud sync and workspace invitations are not connected yet.",
    };
  }

  async createAnnotation(request = {}) {
    const workspaceId = requireWorkspaceRequest(request);
    if (!request.anchor || typeof request.anchor !== "object") {
      throw invalidRequest("Choose a valid code range for the annotation.");
    }
    const result = await this.#annotationManager.createAnnotation({
      workspaceId,
      mutationId: crypto.randomUUID(),
      actor: this.#actor(),
      filePath: request.anchor.path,
      context: request.body,
      range: {
        startLine: request.anchor.startLine,
        startColumn: 1,
        endLine: request.anchor.endLine,
        endColumn: 1,
      },
      anchorRevision: request.anchor.revision ?? null,
      anchorContentHash: request.anchor.contentHash ?? null,
      githubLink: null,
    });
    await this.#emit(workspaceId, "annotations");
    return this.#mapMutation(result.annotation, workspaceId);
  }

  async replyAnnotation(request = {}) {
    const workspaceId = requireWorkspaceRequest(request);
    const annotation = await this.#findAnnotation(workspaceId, request.annotationId);
    const result = await this.#annotationManager.appendReply({
      workspaceId,
      mutationId: crypto.randomUUID(),
      actor: this.#actor(),
      annotationId: annotation.id,
      context: request.body,
      expectedRevision: annotation.revision,
    });
    await this.#emit(workspaceId, "annotations");
    return this.#mapMutation(result.annotation, workspaceId);
  }

  async resolveAnnotation(request = {}) {
    const workspaceId = requireWorkspaceRequest(request);
    if (typeof request.resolved !== "boolean") throw invalidRequest();
    const annotation = await this.#findAnnotation(workspaceId, request.annotationId);
    const result = await this.#annotationManager.resolveAnnotation({
      workspaceId,
      mutationId: crypto.randomUUID(),
      actor: this.#actor(),
      annotationId: annotation.id,
      resolved: request.resolved,
      expectedRevision: annotation.revision,
    });
    await this.#emit(workspaceId, "annotations");
    return this.#mapMutation(result.annotation, workspaceId);
  }

  async requestWriterControl(request = {}) {
    const workspaceId = requireWorkspaceRequest(request);
    const expectedVersion = requireExpectedCounter(request.expectedVersion, "version");
    return this.#serialized(workspaceId, async () => {
      await this.#validateWorkspace(workspaceId);
      try {
        this.#control(workspaceId).requestControl(this.#localMember, { expectedVersion });
      } catch (error) {
        throw controlError(error);
      }
      return this.#writerControl(workspaceId);
    });
  }

  async releaseWriterControl(request = {}) {
    const workspaceId = requireWorkspaceRequest(request);
    const expectedVersion = requireExpectedCounter(request.expectedVersion, "version");
    const expectedFence = requireExpectedCounter(request.expectedFence, "fence");
    return this.#serialized(workspaceId, async () => {
      await this.#validateWorkspace(workspaceId);
      const control = this.#control(workspaceId);
      try {
        const current = control.snapshot(this.#localMember);
        if (current.version !== expectedVersion || current.fence !== expectedFence) {
          throw new WorkspaceError(
            "CONTROL_CHANGED",
            "Control changed before the request could be applied.",
          );
        }
        if (current.typingCount > 0) {
          throw new WorkspaceError(
            "CONTROL_BUSY",
            "Control can only change hands after everyone has stopped typing.",
          );
        }
        control.releaseControl(this.#localMember, { expectedVersion, expectedFence });
      } catch (error) {
        throw controlError(error);
      }
      return this.#writerControl(workspaceId);
    });
  }

  async markTyping(request = {}) {
    const workspaceId = requireWorkspaceRequest(request);
    const expectedFence = requireExpectedCounter(request.expectedFence, "fence");
    return this.#serialized(workspaceId, async () => {
      await this.#validateWorkspace(workspaceId);
      try {
        this.#control(workspaceId).markTyping(this.#localMember, { expectedFence });
      } catch (error) {
        throw controlError(error);
      }
      return this.#writerControl(workspaceId);
    });
  }

  async runWithLocalWriter(workspaceId, operation) {
    requireWorkspaceRequest({ workspaceId });
    if (typeof operation !== "function") throw new TypeError("A workspace mutation is required.");
    return this.#serialized(workspaceId, async () => {
      await this.#validateWorkspace(workspaceId);
      const control = this.#control(workspaceId);
      try {
        const ownership = control.assertOwner(this.#localMember);
        const typing = control.markTyping(this.#localMember, { expectedFence: ownership.fence });
        return await operation({ fence: typing.fence, version: typing.version });
      } catch (error) {
        throw controlError(error);
      }
    });
  }

  async whenIdle(workspaceId) {
    if (typeof workspaceId !== "string" || !workspaceId) return;
    await this.#operationQueues.get(workspaceId);
  }

  disposeWorkspace(workspaceId) {
    const control = this.#controls.get(workspaceId);
    control?.dispose();
    this.#controls.delete(workspaceId);
    this.#operationQueues.delete(workspaceId);
  }

  dispose() {
    for (const control of this.#controls.values()) control.dispose();
    this.#controls.clear();
    this.#operationQueues.clear();
    this.#listeners.clear();
  }

  #actor() {
    return { memberId: this.#localMember.id, displayName: this.#localMember.name };
  }

  #control(workspaceId) {
    let control = this.#controls.get(workspaceId);
    if (!control) {
      control = new ExclusiveControl({ owner: this.#localMember });
      control.onDidChange(() => {
        void this.#emit(workspaceId, "control");
      });
      this.#controls.set(workspaceId, control);
    }
    return control;
  }

  #writerControl(workspaceId) {
    const snapshot = this.#control(workspaceId).snapshot(this.#localMember);
    return {
      mode: snapshot.ownerId ? "held" : "available",
      ownerId: snapshot.ownerId,
      ownerName: snapshot.ownerName,
      ownerIsLocal: snapshot.localHasControl,
      typingCount: snapshot.typingCount,
      requestable: false,
      requestedByLocal: false,
      version: snapshot.version,
      fence: snapshot.fence,
    };
  }

  async #validateWorkspace(workspaceId) {
    await this.#annotationManager.listAnnotations({
      workspaceId,
      includeResolved: true,
      limit: 1,
    });
  }

  async #findAnnotation(workspaceId, annotationId) {
    if (typeof annotationId !== "string" || !annotationId) throw invalidRequest();
    let cursor = null;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await this.#annotationManager.listAnnotations({
        workspaceId,
        includeResolved: true,
        limit: MAX_SNAPSHOT_ANNOTATIONS,
        ...(cursor ? { cursor } : {}),
      });
      const annotation = page.items.find((candidate) => candidate.id === annotationId);
      if (annotation) return annotation;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    throw new WorkspaceError("ANNOTATION_NOT_FOUND", "The annotation no longer exists.");
  }

  async #mapMutation(annotation, workspaceId) {
    const pending = await this.#annotationManager.listPendingMutations({
      workspaceId,
      limit: MAX_SNAPSHOT_ANNOTATIONS,
    });
    const pendingIds = new Set(pending.items.map((entry) => entry.annotationId));
    if (pending.nextSequence !== null) pendingIds.add(annotation.id);
    return mapAnnotation(
      annotation,
      workspaceId,
      this.#localMember,
      pendingIds,
    );
  }

  #serialized(workspaceId, operation) {
    const previous = this.#operationQueues.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => {});
    this.#operationQueues.set(workspaceId, tail);
    void tail.finally(() => {
      if (this.#operationQueues.get(workspaceId) === tail) this.#operationQueues.delete(workspaceId);
    });
    return result;
  }

  async #emit(workspaceId, reason) {
    const event = { workspaceId, reason, snapshot: null, timestamp: Date.now() };
    for (const listener of this.#listeners) {
      try {
        await listener(event);
      } catch (error) {
        console.error("Collaboration listener failed:", error);
      }
    }
  }
}

module.exports = {
  CollaborationManager,
  LOCAL_MEMBER,
  MAX_SNAPSHOT_ANNOTATIONS,
  mapAnnotation,
};
