import assert from "node:assert/strict";
import { test } from "node:test";
import { RepositoryError } from "../src/repository.js";
import { InMemoryControlPlaneRepository } from "../src/repositories/in-memory.js";

const owner = { userId: "owner", displayName: "Owner" };

test("returned records are detached from in-memory repository state", async () => {
  const repository = new InMemoryControlPlaneRepository({
    clock: () => new Date("2026-07-13T12:00:00.000Z"),
  });
  const created = await repository.createWorkspace({ name: "Original", actor: owner });
  created.workspace.name = "Mutated by caller";
  created.membership.displayName = "Mutated by caller";

  const storedWorkspace = await repository.getWorkspace(created.workspace.id);
  const storedMembership = await repository.getMembership(created.workspace.id, owner.userId);
  assert.equal(storedWorkspace?.name, "Original");
  assert.equal(storedMembership?.displayName, "Owner");
});

test("active invite and member limits are enforced inside the adapter", async () => {
  const repository = new InMemoryControlPlaneRepository({
    clock: () => new Date("2026-07-13T12:00:00.000Z"),
    maxActiveInvites: 1,
    maxMembers: 2,
  });
  const { workspace } = await repository.createWorkspace({ name: "Bounded", actor: owner });
  await repository.createInvite({
    workspaceId: workspace.id,
    actor: owner,
    tokenHash: "a".repeat(64),
    expiresInSeconds: 300,
  });

  await assert.rejects(
    repository.createInvite({
      workspaceId: workspace.id,
      actor: owner,
      tokenHash: "b".repeat(64),
      expiresInSeconds: 300,
    }),
    (error: unknown) => error instanceof RepositoryError && error.code === "ACTIVE_INVITE_LIMIT",
  );

  await repository.redeemInvite({
    tokenHash: "a".repeat(64),
    actor: { userId: "member", displayName: "Member" },
  });
  await repository.createInvite({
    workspaceId: workspace.id,
    actor: owner,
    tokenHash: "c".repeat(64),
    expiresInSeconds: 300,
  });
  await assert.rejects(
    repository.redeemInvite({
      tokenHash: "c".repeat(64),
      actor: { userId: "other", displayName: "Other" },
    }),
    (error: unknown) => error instanceof RepositoryError && error.code === "MEMBER_LIMIT",
  );
});

test("the adapter refuses raw or malformed invite tokens at its storage boundary", async () => {
  const repository = new InMemoryControlPlaneRepository();
  const { workspace } = await repository.createWorkspace({ name: "Safe", actor: owner });
  await assert.rejects(
    repository.createInvite({
      workspaceId: workspace.id,
      actor: owner,
      tokenHash: "raw-invite-token",
      expiresInSeconds: 300,
    }),
    /invite token hash/,
  );
  await assert.rejects(
    repository.createInvite({
      workspaceId: workspace.id,
      actor: owner,
      tokenHash: "d".repeat(64),
      expiresInSeconds: 299,
    }),
    /lifetime/,
  );
});
