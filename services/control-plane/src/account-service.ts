import type { AuthenticatedActor } from "./domain.js";
import {
  AccessTokenCodec,
  Argon2idPasswordHasher,
  FixedWindowRateLimiter,
  SecretBox,
  TokenHasher,
  assertPassword,
  normalizeDisplayName,
  normalizeEmail,
  type AccountUser,
} from "./accounts.js";
import type { AccountMailer } from "./mailer.js";
import { newPkceVerifier, pkceChallenge, type GitHubAppBroker, type GitHubOAuthClient } from "./github-auth.js";
import type { ControlPlaneRepository } from "./repository.js";

export type PublicAccount = {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  githubLinked: boolean;
};

export type IssuedSession = {
  accessToken: string;
  refreshToken: string;
  user: PublicAccount;
};

export type AccountServiceOptions = {
  repository: ControlPlaneRepository;
  accessTokens: AccessTokenCodec;
  refreshTokens: TokenHasher;
  actionTokens: TokenHasher;
  passwords?: Argon2idPasswordHasher;
  mailer: AccountMailer;
  publicUrl: string;
  clock?: () => Date;
  rateLimiter?: FixedWindowRateLimiter;
  oauth?: { client: GitHubOAuthClient; secretBox: SecretBox; callbackUrl: string };
  githubApp?: GitHubAppBroker;
};

const ACCESS_TOKEN_SECONDS = 900;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const ACTION_TOKEN_SECONDS = 24 * 60 * 60;
const OAUTH_TRANSACTION_SECONDS = 10 * 60;
const GITHUB_ACCESS_GRANT_SECONDS = 10 * 60;
const DUMMY_PASSWORD_HASH = "argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$nSseRlZC6QzzksIc1McbxNU4abKDaFfLt59srKxd4QU";

function addSeconds(clock: () => Date, seconds: number): string {
  return new Date(clock().getTime() + seconds * 1_000).toISOString();
}

function publicAccount(user: AccountUser, githubLinked: boolean): PublicAccount {
  return { id: user.id, email: user.email, displayName: user.displayName, emailVerified: Boolean(user.emailVerifiedAt), githubLinked };
}

export class AccountService {
  readonly #repository: ControlPlaneRepository;
  readonly #accessTokens: AccessTokenCodec;
  readonly #refreshTokens: TokenHasher;
  readonly #actionTokens: TokenHasher;
  readonly #passwords: Argon2idPasswordHasher;
  readonly #mailer: AccountMailer;
  readonly #publicUrl: URL;
  readonly #clock: () => Date;
  readonly #rateLimiter: FixedWindowRateLimiter;
  readonly #oauth: AccountServiceOptions["oauth"] | undefined;
  readonly #githubApp: GitHubAppBroker | undefined;

  constructor(options: AccountServiceOptions) {
    this.#repository = options.repository;
    this.#accessTokens = options.accessTokens;
    this.#refreshTokens = options.refreshTokens;
    this.#actionTokens = options.actionTokens;
    this.#passwords = options.passwords ?? new Argon2idPasswordHasher();
    this.#mailer = options.mailer;
    this.#publicUrl = new URL(options.publicUrl);
    const local = ["127.0.0.1", "localhost", "::1"].includes(this.#publicUrl.hostname);
    if ((this.#publicUrl.protocol !== "https:" && !(local && this.#publicUrl.protocol === "http:")) || this.#publicUrl.username || this.#publicUrl.password) {
      throw new Error("Trace public URL must use HTTPS outside local development.");
    }
    this.#clock = options.clock ?? (() => new Date());
    this.#rateLimiter = options.rateLimiter ?? new FixedWindowRateLimiter(this.#clock);
    this.#oauth = options.oauth;
    this.#githubApp = options.githubApp;
  }

  rateLimit(route: string, key: string, limit: number, seconds: number): boolean {
    return this.#rateLimiter.consume(`${route}:${key}`, limit, seconds);
  }

  async signUp(input: { email: string; displayName: string; password: string }): Promise<void> {
    const email = normalizeEmail(input.email);
    const displayName = normalizeDisplayName(input.displayName);
    assertPassword(input.password);
    const passwordHash = await this.#passwords.hash(input.password);
    const account = await this.#repository.createAccount({ email, displayName, passwordHash });
    if (account) await this.#sendVerification(account);
  }

  async signIn(input: { email: string; password: string; deviceId: string }): Promise<IssuedSession | null> {
    const email = normalizeEmail(input.email);
    const account = await this.#repository.getAccountByEmail(email);
    const valid = await this.#passwords.verify(input.password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!account || !valid) return null;
    return this.#issueSession(account, input.deviceId);
  }

  async resendVerification(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const account = await this.#repository.getAccountByEmail(email);
    if (account && !account.emailVerifiedAt) await this.#sendVerification(account);
  }

  async verifyEmail(token: string): Promise<boolean> {
    const account = await this.#repository.consumeOneTimeToken("email-verification", this.#actionTokens.hash(token));
    if (!account) return false;
    return Boolean(await this.#repository.markEmailVerified(account.id));
  }

  async requestPasswordReset(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const account = await this.#repository.getAccountByEmail(email);
    if (!account) return;
    const issued = this.#actionTokens.issue();
    await this.#repository.createOneTimeToken({
      kind: "password-reset", userId: account.id, tokenHash: issued.tokenHash, expiresAt: addSeconds(this.#clock, ACTION_TOKEN_SECONDS),
    });
    await this.#mailer.sendPasswordReset({
      to: account.email,
      displayName: account.displayName,
      resetUrl: this.#url("/reset-password", issued.token),
    });
  }

  async resetPassword(token: string, password: string): Promise<boolean> {
    assertPassword(password);
    const account = await this.#repository.consumeOneTimeToken("password-reset", this.#actionTokens.hash(token));
    if (!account) return false;
    // The repository intentionally does not expose a generic password update; a reset consumes its token first.
    const stored = await this.#repository.getAccountById(account.id);
    if (!stored) return false;
    const passwordHash = await this.#passwords.hash(password);
    await this.#repository.replacePassword(account.id, passwordHash);
    await this.#repository.revokeAllDeviceSessions(account.id);
    return true;
  }

  async refresh(refreshToken: string, deviceId: string): Promise<IssuedSession | "reused-or-revoked" | null> {
    const issued = this.#refreshTokens.issue();
    const rotation = await this.#repository.rotateDeviceSession({
      previousRefreshTokenHash: this.#refreshTokens.hash(refreshToken),
      refreshTokenHash: issued.tokenHash,
      deviceId,
      userId: "unused",
      expiresAt: addSeconds(this.#clock, REFRESH_TOKEN_SECONDS),
    });
    if (rotation.kind === "reused-or-revoked") return "reused-or-revoked";
    if (rotation.kind === "missing") return null;
    const githubLinked = Boolean(await this.#repository.getGitHubIdentity(rotation.user.id));
    return {
      accessToken: this.#access(rotation.user, rotation.session.id),
      refreshToken: issued.token,
      user: publicAccount(rotation.user, githubLinked),
    };
  }

  async signOut(refreshToken: string): Promise<void> {
    await this.#repository.revokeDeviceSession(this.#refreshTokens.hash(refreshToken));
  }

  async currentSession(actor: AuthenticatedActor): Promise<PublicAccount | null> {
    const account = await this.#repository.getAccountById(actor.userId);
    if (!account) return null;
    return publicAccount(account, Boolean(await this.#repository.getGitHubIdentity(account.id)));
  }

  async beginGitHubLink(actor: AuthenticatedActor): Promise<{ authorizationUrl: string }> {
    if (!actor.emailVerified) throw new Error("EMAIL_VERIFICATION_REQUIRED");
    if (!this.#oauth) throw new Error("GITHUB_OAUTH_UNAVAILABLE");
    const state = this.#actionTokens.issue();
    const verifier = newPkceVerifier();
    const redirectUri = this.#oauth.callbackUrl;
    await this.#repository.createGitHubOAuthTransaction({
      userId: actor.userId,
      stateHash: state.tokenHash,
      codeVerifierCiphertext: this.#oauth.secretBox.seal(verifier),
      redirectUri,
      expiresAt: addSeconds(this.#clock, OAUTH_TRANSACTION_SECONDS),
    });
    return { authorizationUrl: this.#oauth.client.authorizationUrl({ state: state.token, codeChallenge: pkceChallenge(verifier), redirectUri }) };
  }

  async completeGitHubLink(input: { state: string; code?: string; denied?: boolean }): Promise<"linked" | "denied" | "invalid" | "conflict"> {
    if (input.denied) {
      const transaction = await this.#repository.consumeGitHubOAuthTransaction(this.#actionTokens.hash(input.state));
      return transaction ? "denied" : "invalid";
    }
    if (!input.code) return "invalid";
    if (!this.#oauth) return "invalid";
    const transaction = await this.#repository.consumeGitHubOAuthTransaction(this.#actionTokens.hash(input.state));
    if (!transaction) return "invalid";
    const verifier = this.#oauth.secretBox.open(transaction.codeVerifierCiphertext);
    if (!verifier) return "invalid";
    try {
      const authorized = await this.#oauth.client.exchangeCode({ code: input.code, codeVerifier: verifier, redirectUri: transaction.redirectUri });
      const linked = await this.#repository.linkGitHubIdentity({ userId: transaction.userId, ...authorized.identity });
      if (linked !== "conflict") await this.#repository.replaceGitHubInstallationAccess(transaction.userId, authorized.installations);
      return linked === "conflict" ? "conflict" : "linked";
    } catch {
      return "invalid";
    }
  }

  async githubInstallations(actor: AuthenticatedActor) {
    const identity = await this.#repository.getGitHubIdentity(actor.userId);
    if (!identity || !this.#githubApp) return null;
    return this.#repository.listGitHubInstallations(actor.userId, addSeconds(this.#clock, -GITHUB_ACCESS_GRANT_SECONDS));
  }

  githubInstallUrl(): string | null {
    return this.#githubApp?.installationUrl() ?? null;
  }

  async githubRepositories(actor: AuthenticatedActor, installationId: string) {
    const identity = await this.#repository.getGitHubIdentity(actor.userId);
    if (!identity || !this.#githubApp) return null;
    const allowedRepositories = await this.#repository.listGitHubRepositories(actor.userId, installationId, addSeconds(this.#clock, -GITHUB_ACCESS_GRANT_SECONDS));
    if (allowedRepositories.length === 0) return [];
    const currentRepositories = await this.#githubApp.listRepositories(installationId);
    const allowedIds = new Set(allowedRepositories.map((repository) => repository.id));
    return currentRepositories.filter((repository) => allowedIds.has(repository.id));
  }

  async ensureRepositoryAccess(actor: AuthenticatedActor, installationId: string, owner: string, name: string, defaultBranch: string): Promise<boolean> {
    const repositories = await this.githubRepositories(actor, installationId);
    return Boolean(repositories?.some((repository) => repository.owner === owner && repository.name === name && repository.defaultBranch === defaultBranch));
  }

  async sendWorkspaceInvite(input: { email: string; workspaceName: string; inviterName: string; token: string; expiresAt: string }): Promise<string> {
    const email = normalizeEmail(input.email);
    const inviteUrl = this.#url("/invite", input.token);
    await this.#mailer.sendWorkspaceInvite({
      to: email,
      workspaceName: input.workspaceName,
      inviterName: input.inviterName,
      inviteUrl,
      expiresAt: input.expiresAt,
    });
    return inviteUrl;
  }

  #access(user: AccountUser, sessionId: string): string {
    return this.#accessTokens.issue({ sub: user.id, sid: sessionId, name: user.displayName, email: user.email, verified: Boolean(user.emailVerifiedAt) }, this.#clock(), ACCESS_TOKEN_SECONDS);
  }

  async #issueSession(account: AccountUser, deviceId: string): Promise<IssuedSession> {
    const issued = this.#refreshTokens.issue();
    const session = await this.#repository.createDeviceSession({
      userId: account.id, deviceId, refreshTokenHash: issued.tokenHash, expiresAt: addSeconds(this.#clock, REFRESH_TOKEN_SECONDS),
    });
    const githubLinked = Boolean(await this.#repository.getGitHubIdentity(account.id));
    return { accessToken: this.#access(account, session.id), refreshToken: issued.token, user: publicAccount(account, githubLinked) };
  }

  async #sendVerification(account: AccountUser): Promise<void> {
    const issued = this.#actionTokens.issue();
    await this.#repository.createOneTimeToken({
      kind: "email-verification", userId: account.id, tokenHash: issued.tokenHash, expiresAt: addSeconds(this.#clock, ACTION_TOKEN_SECONDS),
    });
    await this.#mailer.sendVerification({ to: account.email, displayName: account.displayName, verificationUrl: this.#url("/verify-email", issued.token) });
  }

  #url(path: string, token: string): string {
    const url = new URL(path, this.#publicUrl);
    url.searchParams.set("token", token);
    return url.toString();
  }
}
