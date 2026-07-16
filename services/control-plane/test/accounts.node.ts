import assert from "node:assert/strict";
import test from "node:test";
import { AccountService } from "../src/account-service.js";
import { AccessTokenCodec, FixedWindowRateLimiter, SecretBox, TokenHasher } from "../src/accounts.js";
import { buildApp } from "../src/app.js";
import { TraceAccessTokenAuthProvider } from "../src/auth.js";
import type { GitHubAppBroker, GitHubOAuthClient } from "../src/github-auth.js";
import { InviteTokenCodec } from "../src/invite-token.js";
import { InMemoryAccountMailer, ResendAccountMailer } from "../src/mailer.js";
import { InMemoryControlPlaneRepository } from "../src/repositories/in-memory.js";

const SECRET = Buffer.alloc(32, 11).toString("base64");

function tokenFrom(url: string): string {
  const token = new URL(url).searchParams.get("token");
  assert.ok(token);
  return token;
}

function createFixture(options: { enforceGithub?: boolean; limiter?: FixedWindowRateLimiter } = {}) {
  let now = new Date("2026-07-14T12:00:00.000Z");
  const clock = () => new Date(now);
  const repository = new InMemoryControlPlaneRepository({ clock });
  const mailer = new InMemoryAccountMailer();
  const oauth: GitHubOAuthClient = {
    authorizationUrl: ({ state, codeChallenge }) => `https://github.test/authorize?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(codeChallenge)}`,
    async exchangeCode({ code }) {
      if (code === "denied") throw new Error("denied");
      return {
        identity: { providerSubject: code === "other" ? "github-other" : "github-alice", login: code === "other" ? "other" : "alice" },
        installations: [{ id: "42", accountLogin: "acme", accountType: "Organization", repositories: [{ id: "7", owner: "acme", name: "compiler", defaultBranch: "main", private: true }] }],
      };
    },
  };
  const githubApp: GitHubAppBroker = {
    installationUrl: () => "https://github.test/apps/trace/installations/new",
    async listRepositories() { return [{ id: "7", owner: "acme", name: "compiler", defaultBranch: "main", private: true }]; },
  };
  const accessTokens = new AccessTokenCodec(SECRET);
  const accounts = new AccountService({
    repository,
    accessTokens,
    refreshTokens: new TokenHasher(SECRET),
    actionTokens: new TokenHasher(Buffer.alloc(32, 12).toString("base64")),
    mailer,
    publicUrl: "https://trace.test",
    clock,
    rateLimiter: options.limiter ?? new FixedWindowRateLimiter(clock),
    oauth: { client: oauth, secretBox: new SecretBox(Buffer.alloc(32, 13).toString("base64")), callbackUrl: "https://trace.test/v1/github/link/callback" },
    githubApp,
  });
  const app = buildApp({
    repository,
    authProvider: new TraceAccessTokenAuthProvider({ accessTokens, repository, clock }),
    inviteTokens: new InviteTokenCodec(Buffer.alloc(32, 14)),
    accounts,
    requireGitHubRepositoryBinding: options.enforceGithub ?? true,
    requireInviteEmail: true,
  });
  return { app, mailer, repository, accounts, advance: (seconds: number) => { now = new Date(now.getTime() + seconds * 1_000); } };
}

test("Resend delivery uses the provider API without keeping credentials in account state", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const mailer = new ResendAccountMailer({
    apiKey: "re_test_key",
    from: "Trace <accounts@example.com>",
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await mailer.sendVerification({ to: "person@example.com", displayName: "Person", verificationUrl: "https://trace.test/verify-email?token=example" });
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal((request.init.headers as Record<string, string>).authorization, "Bearer re_test_key");
  const payload = JSON.parse(String(request.init.body)) as { to: string[]; subject: string; html: string };
  assert.deepEqual(payload.to, ["person@example.com"]);
  assert.equal(payload.subject, "Verify your Trace email");
  assert.match(payload.html, /verify-email/u);
});

async function json(app: ReturnType<typeof buildApp>, input: any) {
  const response = await app.inject(input);
  return { response, body: response.json() as Record<string, unknown> };
}

async function signUpAndVerify(fixture: ReturnType<typeof createFixture>, email = "alice@example.com", displayName = "Alice") {
  const signUp = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-up", payload: { email, displayName, password: "password-for-testing" } });
  assert.equal(signUp.response.statusCode, 202);
  const verification = fixture.mailer.verification.at(-1);
  assert.ok(verification);
  const verified = await json(fixture.app, { method: "POST", url: "/v1/auth/verify-email", payload: { token: tokenFrom(verification.verificationUrl) } });
  assert.equal(verified.response.statusCode, 200);
}

async function signIn(fixture: ReturnType<typeof createFixture>, email = "alice@example.com") {
  const result = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-in", payload: { email, password: "password-for-testing", deviceId: "test-device" } });
  assert.equal(result.response.statusCode, 200);
  return result.body as { accessToken: string; refreshToken: string; user: { emailVerified: boolean; githubLinked: boolean } };
}

test("account credentials, verification, reset, session rotation, and logout are bounded", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.app.close());
  const first = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-up", payload: { email: "alice@example.com", displayName: "Alice", password: "password-for-testing" } });
  const repeat = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-up", payload: { email: "alice@example.com", displayName: "Alice", password: "password-for-testing" } });
  assert.equal(first.response.statusCode, 202);
  assert.deepEqual(first.body, repeat.body, "sign-up does not disclose whether an email already exists");

  const beforeVerify = await signIn(fixture);
  assert.equal(beforeVerify.user.emailVerified, false);
  const blocked = await json(fixture.app, { method: "POST", url: "/v1/workspaces", headers: { authorization: `Bearer ${beforeVerify.accessToken}` }, payload: { name: "Compiler" } });
  assert.equal(blocked.response.statusCode, 403);
  assert.equal((blocked.body.error as { code: string }).code, "EMAIL_VERIFICATION_REQUIRED");

  const verification = fixture.mailer.verification.at(-1);
  assert.ok(verification);
  const verified = await json(fixture.app, { method: "POST", url: "/v1/auth/verify-email", payload: { token: tokenFrom(verification.verificationUrl) } });
  assert.equal(verified.response.statusCode, 200);
  const reusedVerification = await json(fixture.app, { method: "POST", url: "/v1/auth/verify-email", payload: { token: tokenFrom(verification.verificationUrl) } });
  assert.equal(reusedVerification.response.statusCode, 400);

  const missing = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-in", payload: { email: "missing@example.com", password: "password-for-testing", deviceId: "test-device" } });
  const wrong = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-in", payload: { email: "alice@example.com", password: "wrong-password-value", deviceId: "test-device" } });
  assert.equal(missing.response.statusCode, 401);
  assert.equal(wrong.response.statusCode, 401);
  assert.deepEqual(
    (() => { const { code, message } = missing.body.error as { code: string; message: string }; return { code, message }; })(),
    (() => { const { code, message } = wrong.body.error as { code: string; message: string }; return { code, message }; })(),
    "credential failures share an enumeration-resistant response",
  );

  const signedIn = await signIn(fixture);
  const refreshed = await json(fixture.app, { method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: signedIn.refreshToken, deviceId: "test-device" } });
  assert.equal(refreshed.response.statusCode, 200);
  const replay = await json(fixture.app, { method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: signedIn.refreshToken, deviceId: "test-device" } });
  assert.equal(replay.response.statusCode, 401);
  const rotatedToken = (refreshed.body as { refreshToken: string }).refreshToken;
  const afterReplay = await json(fixture.app, { method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: rotatedToken, deviceId: "test-device" } });
  assert.equal(afterReplay.response.statusCode, 401, "refresh reuse revokes the session family");

  const resetRequestA = await json(fixture.app, { method: "POST", url: "/v1/auth/request-password-reset", payload: { email: "missing@example.com" } });
  const resetRequestB = await json(fixture.app, { method: "POST", url: "/v1/auth/request-password-reset", payload: { email: "alice@example.com" } });
  assert.deepEqual(resetRequestA.body, resetRequestB.body, "reset request does not enumerate accounts");
  const reset = fixture.mailer.passwordResets.at(-1);
  assert.ok(reset);
  const resetToken = tokenFrom(reset.resetUrl);
  const resetLanding = await fixture.app.inject({ method: "GET", url: `/reset-password?token=${encodeURIComponent(resetToken)}` });
  assert.equal(resetLanding.statusCode, 200);
  assert.match(resetLanding.body, new RegExp(`trace://reset-password\\?token=${resetToken}`));
  const confirmed = await json(fixture.app, { method: "POST", url: "/v1/auth/confirm-password-reset", payload: { token: tokenFrom(reset.resetUrl), password: "a-new-safe-password" } });
  assert.equal(confirmed.response.statusCode, 200);
  const reusedReset = await json(fixture.app, { method: "POST", url: "/v1/auth/confirm-password-reset", payload: { token: tokenFrom(reset.resetUrl), password: "another-safe-password" } });
  assert.equal(reusedReset.response.statusCode, 400, "password reset tokens are single use");
  const oldPassword = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-in", payload: { email: "alice@example.com", password: "password-for-testing", deviceId: "test-device" } });
  assert.equal(oldPassword.response.statusCode, 401);
  const newPassword = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-in", payload: { email: "alice@example.com", password: "a-new-safe-password", deviceId: "test-device" } });
  assert.equal(newPassword.response.statusCode, 200);
  await json(fixture.app, { method: "POST", url: "/v1/auth/sign-out", payload: { refreshToken: (newPassword.body as { refreshToken: string }).refreshToken } });
  const loggedOut = await json(fixture.app, { method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: (newPassword.body as { refreshToken: string }).refreshToken, deviceId: "test-device" } });
  assert.equal(loggedOut.response.statusCode, 401);
});

test("verification and password-reset tokens expire after 24 hours", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.app.close());
  const signUp = await json(fixture.app, { method: "POST", url: "/v1/auth/sign-up", payload: { email: "expired@example.com", displayName: "Expired", password: "password-for-testing" } });
  assert.equal(signUp.response.statusCode, 202);
  const verification = fixture.mailer.verification.at(-1);
  assert.ok(verification);
  fixture.advance(24 * 60 * 60 + 1);
  const expiredVerification = await json(fixture.app, { method: "POST", url: "/v1/auth/verify-email", payload: { token: tokenFrom(verification.verificationUrl) } });
  assert.equal(expiredVerification.response.statusCode, 400);

  const resend = await json(fixture.app, { method: "POST", url: "/v1/auth/resend-verification", payload: { email: "expired@example.com" } });
  assert.equal(resend.response.statusCode, 202);
  const resentVerification = fixture.mailer.verification.at(-1);
  assert.ok(resentVerification);
  const verified = await json(fixture.app, { method: "POST", url: "/v1/auth/verify-email", payload: { token: tokenFrom(resentVerification.verificationUrl) } });
  assert.equal(verified.response.statusCode, 200);

  const requested = await json(fixture.app, { method: "POST", url: "/v1/auth/request-password-reset", payload: { email: "expired@example.com" } });
  assert.equal(requested.response.statusCode, 202);
  const reset = fixture.mailer.passwordResets.at(-1);
  assert.ok(reset);
  fixture.advance(24 * 60 * 60 + 1);
  const expiredReset = await json(fixture.app, { method: "POST", url: "/v1/auth/confirm-password-reset", payload: { token: tokenFrom(reset.resetUrl), password: "a-new-safe-password" } });
  assert.equal(expiredReset.response.statusCode, 400);
});

test("rate limits, OAuth PKCE state, GitHub App repository binding, and email invites are enforced", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.app.close());
  await signUpAndVerify(fixture);
  const owner = await signIn(fixture);
  const start = await json(fixture.app, { method: "POST", url: "/v1/github/link/start", headers: { authorization: `Bearer ${owner.accessToken}` } });
  assert.equal(start.response.statusCode, 200);
  const state = new URL((start.body as { authorizationUrl: string }).authorizationUrl).searchParams.get("state");
  assert.ok(state);
  assert.match(new URL((start.body as { authorizationUrl: string }).authorizationUrl).searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  const invalidState = await fixture.app.inject({ method: "GET", url: "/v1/github/link/callback?state=not-a-real-state&code=ok" });
  assert.equal(invalidState.statusCode, 400);
  const callback = await fixture.app.inject({ method: "GET", url: `/v1/github/link/callback?state=${encodeURIComponent(state)}&code=ok` });
  assert.equal(callback.statusCode, 200);
  const replay = await fixture.app.inject({ method: "GET", url: `/v1/github/link/callback?state=${encodeURIComponent(state)}&code=ok` });
  assert.equal(replay.statusCode, 400);
  const session = await json(fixture.app, { method: "GET", url: "/v1/auth/session", headers: { authorization: `Bearer ${owner.accessToken}` } });
  assert.equal(((session.body as { user: { githubLinked: boolean } }).user.githubLinked), true);
  const installations = await json(fixture.app, { method: "GET", url: "/v1/github/app/installations", headers: { authorization: `Bearer ${owner.accessToken}` } });
  assert.deepEqual(installations.body, { installations: [{ id: "42", accountLogin: "acme", accountType: "Organization" }] });
  const repositories = await json(fixture.app, { method: "GET", url: "/v1/github/app/installations/42/repositories", headers: { authorization: `Bearer ${owner.accessToken}` } });
  assert.deepEqual(repositories.body, { repositories: [{ id: "7", owner: "acme", name: "compiler", defaultBranch: "main", private: true }] });

  const workspace = await json(fixture.app, { method: "POST", url: "/v1/workspaces", headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { name: "Compiler", installationId: "42", repository: { provider: "github", owner: "acme", name: "compiler", defaultBranch: "main" } } });
  assert.equal(workspace.response.statusCode, 201);
  const workspaceId = (workspace.body as { workspace: { id: string } }).workspace.id;
  const invite = await json(fixture.app, { method: "POST", url: `/v1/workspaces/${workspaceId}/invites`, headers: { authorization: `Bearer ${owner.accessToken}` }, payload: { email: "teammate@example.com" } });
  assert.equal(invite.response.statusCode, 201);
  const createdInvite = (invite.body as { invite: { token: string; link?: string; expiresAt: string } }).invite;
  assert.ok(createdInvite.link);
  assert.equal(fixture.mailer.workspaceInvites.at(-1)?.inviteUrl, createdInvite.link);
  assert.equal(Date.parse(createdInvite.expiresAt) - Date.parse("2026-07-14T12:00:00.000Z"), 7 * 24 * 60 * 60 * 1_000);
  const inviteLandingUrl = new URL(createdInvite.link);
  const inviteLanding = await fixture.app.inject({ method: "GET", url: `${inviteLandingUrl.pathname}${inviteLandingUrl.search}` });
  assert.equal(inviteLanding.statusCode, 200);
  assert.match(inviteLanding.body, new RegExp(`trace://invite\\?token=${createdInvite.token}`));

  await signUpAndVerify(fixture, "teammate@example.com", "Teammate");
  const teammate = await signIn(fixture, "teammate@example.com");
  const redeemed = await json(fixture.app, { method: "POST", url: "/v1/invites/redeem", headers: { authorization: `Bearer ${teammate.accessToken}` }, payload: { token: createdInvite.token } });
  assert.equal(redeemed.response.statusCode, 200);
  const idempotent = await json(fixture.app, { method: "POST", url: "/v1/invites/redeem", headers: { authorization: `Bearer ${teammate.accessToken}` }, payload: { token: createdInvite.token } });
  assert.equal(idempotent.response.statusCode, 200);

  fixture.advance(10 * 60 + 1);
  const staleRepositories = await json(fixture.app, { method: "GET", url: "/v1/github/app/installations/42/repositories", headers: { authorization: `Bearer ${owner.accessToken}` } });
  assert.deepEqual(staleRepositories.body, { repositories: [] }, "GitHub authorization facts must be refreshed before a later repository bind");

  for (let count = 0; count < 3; count += 1) await json(fixture.app, { method: "POST", url: "/v1/auth/resend-verification", payload: { email: "other@example.com" } });
  const limited = await json(fixture.app, { method: "POST", url: "/v1/auth/resend-verification", payload: { email: "other@example.com" } });
  assert.equal(limited.response.statusCode, 429);
});

test("GitHub callback denial and account-link conflicts are explicit", async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.app.close());
  await signUpAndVerify(fixture);
  const owner = await signIn(fixture);
  const firstStart = await json(fixture.app, { method: "POST", url: "/v1/github/link/start", headers: { authorization: `Bearer ${owner.accessToken}` } });
  const deniedState = new URL((firstStart.body as { authorizationUrl: string }).authorizationUrl).searchParams.get("state");
  assert.ok(deniedState);
  const denied = await fixture.app.inject({ method: "GET", url: `/v1/github/link/callback?state=${encodeURIComponent(deniedState)}&error=access_denied` });
  assert.equal(denied.statusCode, 200);
  assert.match(denied.body, /cancelled/u);

  const ownerStart = await json(fixture.app, { method: "POST", url: "/v1/github/link/start", headers: { authorization: `Bearer ${owner.accessToken}` } });
  const ownerState = new URL((ownerStart.body as { authorizationUrl: string }).authorizationUrl).searchParams.get("state");
  assert.ok(ownerState);
  assert.equal((await fixture.app.inject({ method: "GET", url: `/v1/github/link/callback?state=${encodeURIComponent(ownerState)}&code=ok` })).statusCode, 200);

  await signUpAndVerify(fixture, "second@example.com", "Second");
  const second = await signIn(fixture, "second@example.com");
  const secondStart = await json(fixture.app, { method: "POST", url: "/v1/github/link/start", headers: { authorization: `Bearer ${second.accessToken}` } });
  const secondState = new URL((secondStart.body as { authorizationUrl: string }).authorizationUrl).searchParams.get("state");
  assert.ok(secondState);
  const conflict = await fixture.app.inject({ method: "GET", url: `/v1/github/link/callback?state=${encodeURIComponent(secondState)}&code=ok` });
  assert.equal(conflict.statusCode, 400);
  assert.match(conflict.body, /already linked/u);
});
