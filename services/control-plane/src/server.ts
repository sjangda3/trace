import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { DevBearerAuthProvider } from "./auth.js";
import { InviteTokenCodec } from "./invite-token.js";
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

async function main(): Promise<void> {
  if (process.env.TRACE_ENABLE_DEV_AUTH !== "1") {
    throw new Error(
      "This slice ships only development authentication. Set TRACE_ENABLE_DEV_AUTH=1 explicitly or embed buildApp with a production AuthProvider.",
    );
  }

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
  const app = buildApp({
    repository,
    authProvider: new DevBearerAuthProvider(),
    inviteTokens: new InviteTokenCodec(configuredPepper(Boolean(pool))),
    logger: true,
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
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw new Error("The development-auth executable may listen only on a loopback host.");
  }
  await app.listen({ host, port: boundedPort(process.env.PORT) });
  app.log.warn("Development bearer authentication is enabled; do not expose this process publicly.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "The control plane failed to start.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
