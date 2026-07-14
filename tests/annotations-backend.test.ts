import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  AnnotationManager,
  MAX_CONTEXT_BYTES,
  MAX_LIST_OUTPUT_BYTES,
  MAX_PAGE_SIZE,
  MAX_REPLY_BYTES,
} = require("../electron/annotations.cjs") as Record<string, any>;
const { WorkspaceError } = require("../electron/workspace.cjs") as Record<string, any>;

type AnnotationManagerInstance = InstanceType<typeof AnnotationManager>;

class FakeWorkspaceManager {
  workspaceId: string;
  rootPath: string;
  calls = 0;
  switchAtCall: number | null = null;

  constructor(rootPath: string) {
    this.rootPath = rootPath;
    this.workspaceId = rootPath;
  }

  getExecutionContext(expectedWorkspaceId: string) {
    this.calls += 1;
    if (this.switchAtCall !== null && this.calls >= this.switchAtCall) {
      this.workspaceId = `${this.rootPath}-replacement`;
      this.rootPath = `${this.rootPath}-replacement`;
      this.switchAtCall = null;
    }
    if (expectedWorkspaceId !== this.workspaceId) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace changed.");
    }
    return { workspaceId: this.workspaceId, rootPath: this.rootPath };
  }
}

const actorAda = { memberId: "member:ada", displayName: "Ada Lovelace" };
const actorGrace = { memberId: "member:grace", displayName: "Grace Hopper" };
const codeRange = { startLine: 10, startColumn: 3, endLine: 12, endColumn: 18 };

function mutationId(index: number | string) {
  return `mutation-${index}`;
}

function annotationId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

describe("AnnotationManager backend", () => {
  let directory: string;
  let workspacePath: string;
  let settingsPath: string;
  let workspaceManager: FakeWorkspaceManager;
  let manager: AnnotationManagerInstance;
  let currentTime: number;
  let idCounter: number;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "trace-annotations-"));
    workspacePath = path.join(directory, "workspace");
    settingsPath = path.join(directory, "state", "annotations.v1.json");
    workspaceManager = new FakeWorkspaceManager(workspacePath);
    currentTime = Date.parse("2026-07-13T17:00:00.000Z");
    idCounter = 0;
    manager = new AnnotationManager({
      workspaceManager,
      settingsPath,
      now: () => currentTime,
      randomUUID: () => annotationId(++idCounter),
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createRequest(overrides: Record<string, unknown> = {}) {
    return {
      workspaceId: workspaceManager.workspaceId,
      mutationId: mutationId(1),
      actor: actorAda,
      filePath: "src/editor.ts",
      context: "This ownership transition needs a guard.",
      range: codeRange,
      ...overrides,
    };
  }

  it("persists workspace-bound annotations atomically without storing an absolute workspace path", async () => {
    const created = await manager.createAnnotation(createRequest());
    expect(created).toMatchObject({
      pendingMutationCount: 1,
      replayed: false,
      annotation: {
        id: annotationId(1),
        filePath: "src/editor.ts",
        authorMemberId: actorAda.memberId,
        authorDisplayName: actorAda.displayName,
        resolved: false,
        replies: [],
        revision: 1,
      },
    });
    expect(created.annotation).not.toHaveProperty("workspaceId");
    expect(created.annotation).not.toHaveProperty("rootPath");

    const diskContents = await readFile(settingsPath, "utf8");
    expect(diskContents).not.toContain(workspacePath);
    expect(diskContents).not.toContain("rootPath");
    if (process.platform !== "win32") {
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(settingsPath))).mode & 0o777).toBe(0o700);
    }
    expect((await readdir(path.dirname(settingsPath))).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const reloaded = new AnnotationManager({
      workspaceManager,
      settingsPath,
      now: () => currentTime,
      randomUUID: () => annotationId(++idCounter),
    });
    await expect(reloaded.listAnnotations({ workspaceId: workspacePath })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: annotationId(1), context: createRequest().context })],
      nextCursor: null,
      pendingMutationCount: 1,
    });
  });

  it("uses durable mutation identities for idempotent retries before and after outbox acknowledgement", async () => {
    const first = await manager.createAnnotation(createRequest());
    const replay = await manager.createAnnotation(createRequest());
    expect(replay).toEqual({ ...first, replayed: true });

    await expect(manager.createAnnotation(createRequest({ context: "A different payload" })))
      .rejects.toMatchObject({ code: "MUTATION_CONFLICT" });
    await expect(manager.listAnnotations({ workspaceId: workspacePath })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: annotationId(1) })],
      pendingMutationCount: 1,
    });

    const pending = await manager.listPendingMutations({ workspaceId: workspacePath });
    expect(pending.items).toEqual([
      expect.objectContaining({
        sequence: 1,
        mutationId: mutationId(1),
        operation: "create",
        annotationId: annotationId(1),
        payload: { annotation: expect.objectContaining({ filePath: "src/editor.ts" }) },
      }),
    ]);
    expect(JSON.stringify(pending)).not.toContain(workspacePath);

    await expect(manager.acknowledgeMutations({
      workspaceId: workspacePath,
      mutationIds: [mutationId(1)],
    })).resolves.toEqual({ acknowledged: 1, pendingMutationCount: 0 });
    const replayAfterAcknowledgement = await manager.createAnnotation(createRequest());
    expect(replayAfterAcknowledgement).toMatchObject({
      annotation: { id: annotationId(1) },
      pendingMutationCount: 0,
      replayed: true,
    });
  });

  it("supports replies, edits, resolution, GitHub linkage, and deletion as ordered offline mutations", async () => {
    const githubLink = {
      kind: "pull_request",
      owner: "octo-org",
      repository: "trace",
      number: 17,
      commentId: "9007",
      reviewThreadId: "PRRT_kwDOBounded_1",
    };
    const created = await manager.createAnnotation(createRequest({
      githubLink,
      anchorRevision: "A".repeat(40),
      anchorContentHash: "C".repeat(64),
    }));
    expect(created.annotation.anchorRevision).toBe("a".repeat(40));
    expect(created.annotation.anchorContentHash).toBe("c".repeat(64));
    currentTime += 1_000;
    const replied = await manager.appendReply({
      workspaceId: workspacePath,
      mutationId: mutationId(2),
      actor: actorGrace,
      annotationId: created.annotation.id,
      expectedRevision: 1,
      context: "Agreed — I can cover that edge case.",
    });
    expect(replied.annotation).toMatchObject({
      revision: 2,
      updatedByMemberId: actorGrace.memberId,
      replies: [{
        id: annotationId(2),
        context: "Agreed — I can cover that edge case.",
        authorMemberId: actorGrace.memberId,
      }],
    });

    currentTime += 1_000;
    const updated = await manager.updateAnnotation({
      workspaceId: workspacePath,
      mutationId: mutationId(3),
      actor: actorAda,
      annotationId: created.annotation.id,
      expectedRevision: 2,
      patch: {
        context: "Add a guard before transferring editor ownership.",
        range: { startLine: 9, startColumn: 1, endLine: 12, endColumn: 18 },
        anchorRevision: "B".repeat(64),
        anchorContentHash: "D".repeat(64),
      },
    });
    expect(updated.annotation).toMatchObject({
      revision: 3,
      githubLink,
      anchorRevision: "b".repeat(64),
      anchorContentHash: "d".repeat(64),
      replies: replied.annotation.replies,
    });

    currentTime += 1_000;
    const resolved = await manager.resolveAnnotation({
      workspaceId: workspacePath,
      mutationId: mutationId(4),
      actor: actorGrace,
      annotationId: created.annotation.id,
      expectedRevision: 3,
      resolved: true,
    });
    expect(resolved.annotation).toMatchObject({
      revision: 4,
      resolved: true,
      resolvedByMemberId: actorGrace.memberId,
    });
    expect(resolved.annotation.resolvedAt).toBe(resolved.annotation.updatedAt);

    await expect(manager.updateAnnotation({
      workspaceId: workspacePath,
      mutationId: mutationId("stale"),
      actor: actorAda,
      annotationId: created.annotation.id,
      expectedRevision: 2,
      patch: { context: "Stale edit" },
    })).rejects.toMatchObject({ code: "ANNOTATION_CONFLICT" });

    currentTime += 1_000;
    await expect(manager.deleteAnnotation({
      workspaceId: workspacePath,
      mutationId: mutationId(5),
      actor: actorAda,
      annotationId: created.annotation.id,
      expectedRevision: 4,
    })).resolves.toMatchObject({ id: created.annotation.id, deleted: true, pendingMutationCount: 5 });
    await expect(manager.listAnnotations({ workspaceId: workspacePath })).resolves.toMatchObject({ items: [] });

    const pending = await manager.listPendingMutations({ workspaceId: workspacePath, limit: 10 });
    expect(pending.items.map((entry: any) => entry.operation)).toEqual([
      "create",
      "reply",
      "update",
      "resolve",
      "delete",
    ]);
    expect(pending.items.at(-1)).toMatchObject({
      payload: {
        tombstone: {
          id: created.annotation.id,
          filePath: "src/editor.ts",
          anchorRevision: "b".repeat(64),
          anchorContentHash: "d".repeat(64),
          deletedByMemberId: actorAda.memberId,
          revision: 5,
        },
      },
    });
  });

  it("filters and paginates annotations while enforcing a bounded response", async () => {
    const largeContext = "x".repeat(MAX_CONTEXT_BYTES);
    for (let index = 1; index <= 36; index += 1) {
      currentTime += 1;
      await manager.createAnnotation(createRequest({
        mutationId: mutationId(`page-${index}`),
        filePath: index % 2 === 0 ? "src/even.ts" : "src/odd.ts",
        context: largeContext,
      }));
    }

    const firstPage = await manager.listAnnotations({
      workspaceId: workspacePath,
      includeResolved: false,
      limit: MAX_PAGE_SIZE,
    });
    expect(firstPage.items.length).toBeGreaterThan(1);
    expect(firstPage.items.length).toBeLessThan(36);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(Buffer.byteLength(JSON.stringify(firstPage), "utf8")).toBeLessThanOrEqual(MAX_LIST_OUTPUT_BYTES + 512);

    const secondPage = await manager.listAnnotations({
      workspaceId: workspacePath,
      includeResolved: false,
      limit: MAX_PAGE_SIZE,
      cursor: firstPage.nextCursor,
    });
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size)
      .toBe(firstPage.items.length + secondPage.items.length);

    const even = await manager.listAnnotations({
      workspaceId: workspacePath,
      filePath: "src/even.ts",
      limit: 100,
    });
    expect(even.items).toHaveLength(18);
    expect(even.items.every((item: any) => item.filePath === "src/even.ts")).toBe(true);
  });

  it("serializes concurrent mutations without losing annotations", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, index) => manager.createAnnotation(createRequest({
      mutationId: mutationId(`concurrent-${index}`),
      filePath: `src/file-${index}.ts`,
    }))));
    const listed = await manager.listAnnotations({ workspaceId: workspacePath, limit: 20 });
    expect(listed.items).toHaveLength(12);
    expect(listed.pendingMutationCount).toBe(12);
  });

  it("rejects malformed paths, ranges, members, context, linkage, cursors, and unknown fields", async () => {
    const invalidRequests = [
      createRequest({ mutationId: "short" }),
      createRequest({ filePath: "/tmp/secret.ts" }),
      createRequest({ filePath: "../secret.ts" }),
      createRequest({ filePath: "src\\secret.ts" }),
      createRequest({ actor: { memberId: "member with spaces", displayName: "Bad" } }),
      createRequest({ context: "   \n\t" }),
      createRequest({ context: "x".repeat(MAX_CONTEXT_BYTES + 1) }),
      createRequest({ range: { startLine: 2, startColumn: 1, endLine: 1, endColumn: 1 } }),
      createRequest({ githubLink: { kind: "pull_request", owner: "-bad", repository: "repo", number: 1 } }),
      createRequest({ anchorRevision: "not-a-git-oid" }),
      createRequest({ anchorContentHash: "not-a-content-hash" }),
      createRequest({ unexpected: true }),
    ];
    for (const request of invalidRequests) {
      await expect(manager.createAnnotation(request)).rejects.toMatchObject({
        code: expect.stringMatching(/INVALID_REQUEST|INVALID_PATH/),
      });
    }
    await expect(manager.listAnnotations({ workspaceId: workspacePath, cursor: "not-a-real-cursor" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const created = await manager.createAnnotation(createRequest());
    await expect(manager.appendReply({
      workspaceId: workspacePath,
      mutationId: mutationId(2),
      actor: actorAda,
      annotationId: created.annotation.id,
      context: "x".repeat(MAX_REPLY_BYTES + 1),
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(manager.updateAnnotation({
      workspaceId: workspacePath,
      mutationId: mutationId(3),
      actor: actorAda,
      annotationId: created.annotation.id,
      patch: { context: "Okay", unknown: true },
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("revalidates the workspace after durable persistence and makes the retry safe", async () => {
    workspaceManager.switchAtCall = 5;
    await expect(manager.createAnnotation(createRequest())).rejects.toMatchObject({ code: "WORKSPACE_CHANGED" });

    workspaceManager.workspaceId = workspacePath;
    workspaceManager.rootPath = workspacePath;
    workspaceManager.calls = 0;
    const replay = await manager.createAnnotation(createRequest());
    expect(replay).toMatchObject({
      annotation: { id: annotationId(1) },
      pendingMutationCount: 1,
      replayed: true,
    });
    await expect(manager.listAnnotations({ workspaceId: workspacePath })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: annotationId(1) })],
    });
  });

  it("fails closed for corrupt or symbolic-link storage", async () => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "not json");
    await expect(manager.listAnnotations({ workspaceId: workspacePath }))
      .rejects.toMatchObject({ code: "ANNOTATION_STORAGE_CORRUPT" });

    await rm(settingsPath, { force: true });
    const targetPath = path.join(directory, "attacker.json");
    await writeFile(targetPath, JSON.stringify({ version: 1, workspaces: {} }));
    try {
      await symlink(targetPath, settingsPath);
    } catch (error) {
      if (["EACCES", "EINVAL", "ENOSYS", "ENOTSUP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(manager.listAnnotations({ workspaceId: workspacePath }))
      .rejects.toMatchObject({ code: expect.stringMatching(/IO_ERROR|ANNOTATION_STORAGE_CORRUPT/) });
  });
});
