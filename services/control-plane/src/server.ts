import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { AccountService } from "./account-service.js";
import { buildApp } from "./app.js";
import { AccessTokenCodec, SecretBox, TokenHasher } from "./accounts.js";
import { DevBearerAuthProvider, TraceAccessTokenAuthProvider } from "./auth.js";
import { GitHubAppApiBroker, GitHubOAuthWebClient } from "./github-auth.js";
import { InviteTokenCodec } from "./invite-token.js";
import { ResendAccountMailer } from "./mailer.js";
import { InMemoryControlPlaneRepository } from "./repositories/in-memory.js";
import { PostgresControlPlaneRepository } from "./repositories/postgres.js";

function boundedPort(value: string | undefined): number {
  if (value === undefined) return 8_787;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function configuredPepper(databaseEnabled: boolean): Buffer {
  const encoded = process.env.TRACE_INVITE_TOKEN_PEPPER;
  if (!encoded) {
    if (databaseEnabled) {
      throw new Error("TRACE_INVITE_TOKEN_PEPPER is required with DATABASE_URL.");
    }
    return randomBytes(32);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("TRACE_INVITE_TOKEN_PEPPER must be base64 encoded.");
  }
  const pepper = Buffer.from(encoded, "base64");
  if (pepper.byteLength < 32) {
    throw new Error("TRACE_INVITE_TOKEN_PEPPER must decode to at least 32 bytes.");
  }
  return pepper;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for production account authentication.`);
  return value;
}

async function main(): Promise<void> {
  const developmentAuth = process.env.TRACE_ENABLE_DEV_AUTH === "1";

  const connectionString = process.env.DATABASE_URL;
  const useMemory = process.env.TRACE_IN_MEMORY === "1";
  if (!connectionString && !useMemory) {
    throw new Error("Set DATABASE_URL or explicitly opt into TRACE_IN_MEMORY=1.");
  }

  const pool = connectionString
      ? new Pool({
        connectionString,
        max: 10,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 5_000,
        query_timeout: 7_000,
        application_name: "trace-control-plane",
      })
    : null;
  const repository = pool
    ? new PostgresControlPlaneRepository(pool)
    : new InMemoryControlPlaneRepository();
  let authProvider;
  let accounts: AccountService | undefined;
  if (developmentAuth) {
    authProvider = new DevBearerAuthProvider();
  } else {
    if (!pool) throw new Error("Production account authentication requires DATABASE_URL; TRACE_IN_MEMORY is development-only.");
    const publicUrl = requiredEnvironment("TRACE_PUBLIC_URL");
    const accessTokens = new AccessTokenCodec(requiredEnvironment("TRACE_ACCESS_TOKEN_SIGNING_KEY"));
    const oauth = new GitHubOAuthWebClient({
      clientId: requiredEnvironment("TRACE_GITHUB_OAUTH_CLIENT_ID"),
      clientSecret: requiredEnvironment("TRACE_GITHUB_OAUTH_CLIENT_SECRET"),
      callbackUrl: process.env.TRACE_GITHUB_OAUTH_CALLBACK_URL?.trim() || new URL("/v1/github/link/callback", publicUrl).toString(),
    });
    const githubApp = new GitHubAppApiBroker({
      appId: requiredEnvironment("TRACE_GITHUB_APP_ID"),
      privateKey: requiredEnvironment("TRACE_GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
      slug: requiredEnvironment("TRACE_GITHUB_APP_SLUG"),
    });
    accounts = new AccountService({
      repository,
      accessTokens,
      refreshTokens: new TokenHasher(requiredEnvironment("TRACE_REFRESH_TOKEN_PEPPER")),
      actionTokens: new TokenHasher(requiredEnvironment("TRACE_ACTION_TOKEN_PEPPER")),
      mailer: new ResendAccountMailer({ apiKey: requiredEnvironment("TRACE_RESEND_API_KEY"), from: requiredEnvironment("TRACE_RESEND_FROM") }),
      publicUrl,
      oauth: { client: oauth, secretBox: new SecretBox(requiredEnvironment("TRACE_OAUTH_ENCRYPTION_KEY")), callbackUrl: process.env.TRACE_GITHUB_OAUTH_CALLBACK_URL?.trim() || new URL("/v1/github/link/callback", publicUrl).toString() },
      githubApp,
    });
    authProvider = new TraceAccessTokenAuthProvider({ accessTokens, repository });
  }
  const app = buildApp({
    repository,
    authProvider,
    inviteTokens: new InviteTokenCodec(configuredPepper(Boolean(pool))),
    ...(accounts ? { accounts, requireGitHubRepositoryBinding: true, requireInviteEmail: true } : {}),
    logger: {
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "req.url"],
        censor: "[redacted]",
      },
    },
  });

  if (pool) {
    app.addHook("onClose", async () => {
      await pool.end();
    });
  }

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "Shutting down control plane");
    await app.close();
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  const host = process.env.HOST?.trim() || "127.0.0.1";
  if (developmentAuth && !new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw new Error("Development bearer authentication may listen only on a loopback host.");
  }
  await app.listen({ host, port: boundedPort(process.env.PORT) });
  if (developmentAuth) app.log.warn("Development bearer authentication is enabled; do not expose this process publicly.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "The control plane failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
