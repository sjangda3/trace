import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSnapshotEnvelope } from "@trace/collaboration-protocol";
import { Pool } from "pg";
import { createInitialSnapshotEnvelope } from "../src/protocol-adapter.js";
import { RepositoryError } from "../src/repository.js";
import { PostgresControlPlaneRepository } from "../src/repositories/postgres.js";

const connectionString = process.env.TEST_DATABASE_URL;

test(
  "PostgreSQL repository atomically redeems one-time invites",
  { skip: connectionString ? false : "TEST_DATABASE_URL is not set" },
  async () => {
    assert.ok(connectionString);
    const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5_000 });
    const repository = new PostgresControlPlaneRepository(pool);
    const owner = { userId: `owner_${Date.now()}`, displayName: "Postgres owner" };
    const { workspace } = await repository.createWorkspace({
      name: "Integration workspace",
      actor: owner,
      repository: {
        provider: "github",
        owner: "trace",
        name: "desktop",
        defaultBranch: "main",
      },
    });
    try {
      const tokenHash = "e".repeat(64);
      await repository.createInvite({
        workspaceId: workspace.id,
        actor: owner,
        tokenHash,
        expiresInSeconds: 300,
      });

      const results = await Promise.allSettled([
        repository.redeemInvite({
          tokenHash,
          actor: { userId: `member_a_${Date.now()}`, displayName: "Member A" },
        }),
        repository.redeemInvite({
          tokenHash,
          actor: { userId: `member_b_${Date.now()}`, displayName: "Member B" },
        }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.ok(rejected.reason instanceof RepositoryError);
      assert.equal(rejected.reason.code, "INVITE_UNAVAILABLE");

      const members = await repository.listMembers(workspace.id);
      assert.equal(members.length, 2);
      assert.ok(members.every((member) => member.memberId !== member.userId));
      const snapshot = await repository.getRoomSnapshotState(workspace.id);
      assert.equal(snapshot?.workspace.id, workspace.id);
      assert.deepEqual(snapshot?.codeControl, {
        resource: "code",
        holderUserId: null,
        version: 0,
        fence: 0,
        typingCount: 0,
        typingUntil: null,
      });
      const bootstrap = await repository.getWorkspaceBootstrapState(workspace.id);
      assert.ok(bootstrap);
      const envelope = createInitialSnapshotEnvelope(bootstrap, "2026-07-13T12:00:00.000Z");
      assert.equal(validateSnapshotEnvelope(envelope).ok, true);
      assert.deepEqual(envelope.snapshot.repository, {
        provider: "github",
        owner: "trace",
        name: "desktop",
        defaultBranch: "main",
      });
    } finally {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspace.id]);
      await pool.end();
    }
  },
);
