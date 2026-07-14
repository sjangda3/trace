import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { CollaborationManager } = require("../electron/collaboration.cjs") as {
  CollaborationManager: new (options: Record<string, unknown>) => any;
};

function storedAnnotation(overrides: Record<string, unknown> = {}) {
  return {
    id: "annotation-0001",
    filePath: "src/app.ts",
    context: "Keep the written context here.",
    range: { startLine: 4, startColumn: 1, endLine: 6, endColumn: 1 },
    authorMemberId: "local",
    authorDisplayName: "You",
    createdAt: "2026-07-13T18:00:00.000Z",
    updatedAt: "2026-07-13T18:00:00.000Z",
    updatedByMemberId: "local",
    resolved: false,
    resolvedAt: null,
    resolvedByMemberId: null,
    githubLink: null,
    anchorRevision: "a".repeat(40),
    anchorContentHash: "c".repeat(64),
    replies: [],
    revision: 1,
    ...overrides,
  };
}

function annotationManager(annotation = storedAnnotation()) {
  return {
    listAnnotations: vi.fn(async () => ({
      items: [annotation],
      nextCursor: null,
      pendingMutationCount: 1,
    })),
    listPendingMutations: vi.fn(async () => ({
      items: [{ annotationId: annotation.id }],
      nextSequence: null,
      pendingMutationCount: 1,
    })),
    createAnnotation: vi.fn(async () => ({ annotation, pendingMutationCount: 1, replayed: false })),
    appendReply: vi.fn(async () => ({ annotation, pendingMutationCount: 1, replayed: false })),
    resolveAnnotation: vi.fn(async () => ({ annotation, pendingMutationCount: 1, replayed: false })),
  };
}

describe("CollaborationManager", () => {
  it("maps local annotations into an honest offline collaboration snapshot", async () => {
    const annotations = annotationManager();
    const manager = new CollaborationManager({ annotationManager: annotations });

    const snapshot = await manager.snapshot({ workspaceId: "workspace-1" });

    expect(snapshot.connection).toBe("offline");
    expect(snapshot.syncStatus).toBe("offline");
    expect(snapshot.pendingOperations).toBe(1);
    expect(snapshot.members).toMatchObject([{ id: "local", displayName: "You", isLocal: true }]);
    expect(snapshot.writerControl).toMatchObject({ ownerId: "local", ownerIsLocal: true, mode: "held" });
    expect(snapshot.annotations[0]).toMatchObject({
      id: "annotation-0001",
      anchor: {
        path: "src/app.ts",
        startLine: 4,
        endLine: 6,
        revision: "a".repeat(40),
        contentHash: "c".repeat(64),
      },
      messages: [{ body: "Keep the written context here.", syncStatus: "pending" }],
    });
  });

  it("owns actor identity and translates a renderer anchor into bounded storage fields", async () => {
    const annotation = storedAnnotation();
    const annotations = annotationManager(annotation);
    const manager = new CollaborationManager({ annotationManager: annotations });
    const events: unknown[] = [];
    manager.onDidChange((event: unknown) => events.push(event));

    const result = await manager.createAnnotation({
      workspaceId: "workspace-1",
      actor: { memberId: "spoofed", displayName: "Spoofed" },
      anchor: {
        path: "src/app.ts",
        startLine: 4,
        endLine: 6,
        revision: "a".repeat(40),
        contentHash: "c".repeat(64),
      },
      body: "Keep the written context here.",
    });

    expect(annotations.createAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      actor: { memberId: "local", displayName: "You" },
      filePath: "src/app.ts",
      context: "Keep the written context here.",
      range: { startLine: 4, startColumn: 1, endLine: 6, endColumn: 1 },
      anchorRevision: "a".repeat(40),
      anchorContentHash: "c".repeat(64),
    }));
    expect(result.id).toBe(annotation.id);
    expect(events).toMatchObject([{ workspaceId: "workspace-1", reason: "annotations", snapshot: null }]);
  });

  it("uses the current annotation revision for replies", async () => {
    const annotation = storedAnnotation({ revision: 7 });
    const annotations = annotationManager(annotation);
    const manager = new CollaborationManager({ annotationManager: annotations });

    await manager.replyAnnotation({
      workspaceId: "workspace-1",
      annotationId: annotation.id,
      body: "A follow-up.",
    });

    expect(annotations.appendReply).toHaveBeenCalledWith(expect.objectContaining({
      annotationId: annotation.id,
      context: "A follow-up.",
      expectedRevision: 7,
      actor: { memberId: "local", displayName: "You" },
    }));
  });

  it("keeps editor control fenced and main-owned", async () => {
    const annotations = annotationManager();
    const manager = new CollaborationManager({ annotationManager: annotations });

    const released = await manager.releaseWriterControl({
      workspaceId: "workspace-1",
      expectedVersion: 0,
      expectedFence: 0,
    });
    expect(released).toMatchObject({
      mode: "available",
      ownerId: null,
      ownerIsLocal: false,
      version: 1,
      fence: 1,
    });

    await expect(manager.requestWriterControl({
      workspaceId: "workspace-1",
      expectedVersion: 0,
    })).rejects.toMatchObject({ code: "CONTROL_CHANGED" });

    const held = await manager.requestWriterControl({
      workspaceId: "workspace-1",
      expectedVersion: 1,
    });
    expect(held).toMatchObject({
      mode: "held",
      ownerId: "local",
      ownerIsLocal: true,
      version: 2,
      fence: 2,
    });

    await expect(manager.runWithLocalWriter(
      "workspace-1",
      async ({ fence, version }: { fence: number; version: number }) => ({ fence, version }),
    )).resolves.toEqual({ fence: 2, version: 3 });
    await expect(manager.releaseWriterControl({
      workspaceId: "workspace-1",
      expectedVersion: 3,
      expectedFence: 2,
    })).rejects.toMatchObject({ code: "CONTROL_BUSY" });

    manager.dispose();
  });
});
