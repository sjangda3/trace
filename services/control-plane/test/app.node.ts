import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import { DevBearerAuthProvider } from "../src/auth.js";
import { InviteTokenCodec } from "../src/invite-token.js";
import { InMemoryControlPlaneRepository } from "../src/repositories/in-memory.js";

const OWNER_AUTH = { authorization: "Bearer dev:owner" };
const MEMBER_AUTH = { authorization: "Bearer dev:member" };
const OTHER_AUTH = { authorization: "Bearer dev:other" };

function createHarness(clock: () => Date = () => new Date("2026-07-13T12:00:00.000Z")) {
  const repository = new InMemoryControlPlaneRepository({ clock });
  const app = buildApp({
    repository,
    authProvider: new DevBearerAuthProvider(),
    inviteTokens: new InviteTokenCodec(Buffer.alloc(32, 7)),
  });
  return { app, repository };
}

async function createWorkspace(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: OWNER_AUTH,
    payload: { name: "  Demo workspace  " },
  });
  assert.equal(response.statusCode, 201);
  return response.json<{
    workspace: { id: string; roomId: string; name: string };
    membership: { role: string; userId: string };
  }>();
}

async function createInvite(app: ReturnType<typeof buildApp>, workspaceId: string) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/invites`,
    headers: OWNER_AUTH,
    payload: { expiresInSeconds: 300 },
  });
  assert.equal(response.statusCode, 201);
  return response.json<{ invite: { token: string; workspaceId: string; role: string } }>().invite;
}

test("health and errors use bounded, structured responses", async (t) => {
  const { app } = createHarness();
  t.after(() => app.close());

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), {
    status: "ok",
    service: "trace-control-plane",
    version: "0.1.0",
  });

  const unauthenticated = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    payload: { name: "Demo" },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json<{ error: { code: string } }>().error.code, "UNAUTHENTICATED");

  const invalid = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: OWNER_AUTH,
    payload: { name: "Demo", unexpected: true },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(
    Object.keys(invalid.json<{ error: Record<string, unknown> }>().error).sort(),
    ["code", "message", "requestId"],
  );
  assert.equal(
    invalid.json<{ error: { message: string } }>().error.message,
    "The request did not match the API schema.",
  );

  const whitespace = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: OWNER_AUTH,
    payload: { name: "    " },
  });
  assert.equal(whitespace.statusCode, 400);
  assert.equal(whitespace.json<{ error: { code: string } }>().error.code, "INVALID_REQUEST");

  const tooLarge = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: OWNER_AUTH,
    payload: { name: "x".repeat(20_000) },
  });
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.json<{ error: { code: string } }>().error.code, "PAYLOAD_TOO_LARGE");

  const missing = await app.inject({ method: "GET", url: "/does-not-exist" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json<{ error: { code: string } }>().error.code, "NOT_FOUND");
});

test("repository binding is additive and does not change the REST response shape", async (t) => {
  const { app, repository } = createHarness();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: OWNER_AUTH,
    payload: {
      name: "Bound workspace",
      repository: {
        provider: "github",
        owner: "trace",
        name: "desktop",
        defaultBranch: "main",
      },
    },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json<{
    workspace: { id: string } & Record<string, unknown>;
    membership: Record<string, unknown>;
  }>();
  assert.equal("repository" in body.workspace, false);
  assert.equal("memberId" in body.membership, false);
  const bootstrap = await repository.getWorkspaceBootstrapState(body.workspace.id);
  assert.deepEqual(bootstrap?.repository, {
    provider: "github",
    owner: "trace",
    name: "desktop",
    defaultBranch: "main",
  });
});

test("workspace, invite, membership, and room snapshot flow enforces roles", async (t) => {
  const { app } = createHarness();
  t.after(() => app.close());

  const created = await createWorkspace(app);
  assert.equal(created.workspace.name, "Demo workspace");
  assert.equal(created.membership.role, "owner");
  assert.equal(created.membership.userId, "owner");

  const hiddenFromNonmember = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${created.workspace.id}/members`,
    headers: MEMBER_AUTH,
  });
  assert.equal(hiddenFromNonmember.statusCode, 404);
  assert.equal(
    hiddenFromNonmember.json<{ error: { code: string } }>().error.code,
    "WORKSPACE_NOT_FOUND",
  );

  const invite = await createInvite(app, created.workspace.id);
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invite.workspaceId, created.workspace.id);
  assert.equal(invite.role, "member");

  const redeemed = await app.inject({
    method: "POST",
    url: "/v1/invites/redeem",
    headers: MEMBER_AUTH,
    payload: { token: invite.token },
  });
  assert.equal(redeemed.statusCode, 200);
  const redeemedBody = redeemed.json<{
    workspace: { id: string };
    membership: { role: string; userId: string };
  }>();
  assert.equal(redeemedBody.workspace.id, created.workspace.id);
  assert.deepEqual(redeemedBody.membership, {
    workspaceId: created.workspace.id,
    userId: "member",
    displayName: "member",
    role: "member",
    joinedAt: "2026-07-13T12:00:00.000Z",
  });
  assert.equal("token" in redeemedBody, false);

  const reused = await app.inject({
    method: "POST",
    url: "/v1/invites/redeem",
    headers: OTHER_AUTH,
    payload: { token: invite.token },
  });
  assert.equal(reused.statusCode, 410);
  assert.equal(reused.json<{ error: { code: string } }>().error.code, "INVITE_UNAVAILABLE");

  const memberCannotInvite = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${created.workspace.id}/invites`,
    headers: MEMBER_AUTH,
    payload: {},
  });
  assert.equal(memberCannotInvite.statusCode, 403);
  assert.equal(memberCannotInvite.json<{ error: { code: string } }>().error.code, "OWNER_REQUIRED");

  const listed = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${created.workspace.id}/members`,
    headers: MEMBER_AUTH,
  });
  assert.equal(listed.statusCode, 200);
  const members = listed.json<{ members: Array<{ userId: string; role: string }> }>().members;
  assert.deepEqual(
    members.map(({ userId, role }) => ({ userId, role })),
    [
      { userId: "owner", role: "owner" },
      { userId: "member", role: "member" },
    ],
  );

  const snapshot = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${created.workspace.id}/room-snapshot`,
    headers: MEMBER_AUTH,
  });
  assert.equal(snapshot.statusCode, 200);
  const snapshotBody = snapshot.json<{
    workspace: { roomId: string; roomSequence: number };
    viewer: { role: string };
    members: unknown[];
    codeControl: {
      resource: string;
      holderUserId: string | null;
      version: number;
      fence: number;
      typingCount: number;
    };
  }>();
  assert.equal(snapshotBody.workspace.roomId, created.workspace.roomId);
  assert.equal(snapshotBody.workspace.roomSequence, 0);
  assert.equal(snapshotBody.viewer.role, "member");
  assert.equal(snapshotBody.members.length, 2);
  assert.deepEqual(snapshotBody.codeControl, {
    resource: "code",
    holderUserId: null,
    version: 0,
    fence: 0,
    typingCount: 0,
    typingUntil: null,
  });
});

test("an existing member cannot consume an invite intended for a new member", async (t) => {
  const { app } = createHarness();
  t.after(() => app.close());
  const created = await createWorkspace(app);
  const invite = await createInvite(app, created.workspace.id);

  const ownerAttempt = await app.inject({
    method: "POST",
    url: "/v1/invites/redeem",
    headers: OWNER_AUTH,
    payload: { token: invite.token },
  });
  assert.equal(ownerAttempt.statusCode, 409);
  assert.equal(ownerAttempt.json<{ error: { code: string } }>().error.code, "ALREADY_MEMBER");

  const memberAttempt = await app.inject({
    method: "POST",
    url: "/v1/invites/redeem",
    headers: MEMBER_AUTH,
    payload: { token: invite.token },
  });
  assert.equal(memberAttempt.statusCode, 200);
});

test("one-time invite redemption is atomic under concurrent requests", async (t) => {
  const { app } = createHarness();
  t.after(() => app.close());
  const created = await createWorkspace(app);
  const invite = await createInvite(app, created.workspace.id);

  const responses = await Promise.all([
    app.inject({
      method: "POST",
      url: "/v1/invites/redeem",
      headers: MEMBER_AUTH,
      payload: { token: invite.token },
    }),
    app.inject({
      method: "POST",
      url: "/v1/invites/redeem",
      headers: OTHER_AUTH,
      payload: { token: invite.token },
    }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort((left, right) => left - right),
    [200, 410],
  );
});

test("expired invites return the same unavailable response as unknown invites", async (t) => {
  let now = Date.parse("2026-07-13T12:00:00.000Z");
  const { app } = createHarness(() => new Date(now));
  t.after(() => app.close());
  const created = await createWorkspace(app);
  const invite = await createInvite(app, created.workspace.id);
  now += 300_000;

  const expired = await app.inject({
    method: "POST",
    url: "/v1/invites/redeem",
    headers: MEMBER_AUTH,
    payload: { token: invite.token },
  });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.json<{ error: { code: string } }>().error.code, "INVITE_UNAVAILABLE");
});
