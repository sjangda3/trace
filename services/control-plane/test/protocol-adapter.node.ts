import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSnapshotEnvelope } from "@trace/collaboration-protocol";
import {
  ProtocolAdapterError,
  createInitialSnapshotEnvelope,
  cursorForRoomSequence,
} from "../src/protocol-adapter.js";
import { InMemoryControlPlaneRepository } from "../src/repositories/in-memory.js";

const generatedAt = "2026-07-13T12:00:00.000Z";
const repositoryBinding = {
  provider: "github" as const,
  owner: "trace",
  name: "desktop",
  defaultBranch: "main",
};

test("a bound workspace emits a protocol-valid initial snapshot envelope", async () => {
  const repository = new InMemoryControlPlaneRepository({
    clock: () => new Date(generatedAt),
  });
  const created = await repository.createWorkspace({
    name: "Protocol workspace",
    actor: { userId: "account-owner", displayName: "Owner" },
    repository: repositoryBinding,
  });
  const state = await repository.getWorkspaceBootstrapState(created.workspace.id);
  assert.ok(state);

  const envelope = createInitialSnapshotEnvelope(state, generatedAt);
  const validation = validateSnapshotEnvelope(envelope);
  assert.equal(validation.ok, true);
  assert.equal(envelope.sequence, 0);
  assert.equal(envelope.snapshot.snapshotVersion, 0);
  assert.equal(
    envelope.cursor,
    cursorForRoomSequence(created.workspace.roomId, created.workspace.roomSequence),
  );
  assert.deepEqual(envelope.snapshot.repository, repositoryBinding);
  assert.deepEqual(envelope.snapshot.presence, []);
  assert.deepEqual(envelope.snapshot.annotations, []);
  assert.deepEqual(envelope.snapshot.recoveryDrafts, []);
  assert.deepEqual(envelope.snapshot.writerControls, [
    {
      resource: { kind: "workspace", channel: "editor" },
      ownerMemberId: null,
      ownerClientId: null,
      leaseExpiresAt: null,
      version: 0,
      fence: 0,
      typingCount: 0,
      typingUntil: null,
    },
  ]);
  assert.equal(envelope.snapshot.members[0]?.memberId, created.membership.memberId);
  assert.notEqual(envelope.snapshot.members[0]?.memberId, created.membership.userId);
  assert.equal("userId" in (envelope.snapshot.members[0] ?? {}), false);
});

test("the adapter refuses to invent a repository for an unbound workspace", async () => {
  const repository = new InMemoryControlPlaneRepository({
    clock: () => new Date(generatedAt),
  });
  const created = await repository.createWorkspace({
    name: "Unbound workspace",
    actor: { userId: "account-owner", displayName: "Owner" },
  });
  const state = await repository.getWorkspaceBootstrapState(created.workspace.id);
  assert.ok(state);
  assert.throws(
    () => createInitialSnapshotEnvelope(state, generatedAt),
    (error: unknown) =>
      error instanceof ProtocolAdapterError && error.issues[0]?.keyword === "repositoryBinding",
  );
});
