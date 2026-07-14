import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

const MIGRATION_NAME_PATTERN = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const LOCK_NAME = "trace_control_plane_migrations";

type AppliedMigration = {
  name: string;
  checksum: string;
};

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS control_plane_schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT control_plane_schema_migrations_checksum_format
        CHECK (checksum ~ '^[0-9a-f]{64}$')
    )
  `);
}

async function applyMigration(
  client: PoolClient,
  name: string,
  sql: string,
  checksum: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO control_plane_schema_migrations (name, checksum) VALUES ($1, $2)`,
      [name, checksum],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to run migrations.");
  const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: "trace-control-plane-migrate",
  });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
    await ensureMigrationTable(client);
    const appliedResult = await client.query<AppliedMigration>(
      "SELECT name, checksum FROM control_plane_schema_migrations ORDER BY name",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.name, row.checksum]));
    const names = (await readdir(migrationDirectory))
      .filter((name) => MIGRATION_NAME_PATTERN.test(name))
      .sort();
    for (const name of names) {
      const sql = await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql, "utf8").digest("hex");
      const existingChecksum = applied.get(name);
      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new Error(`Applied migration ${name} has been modified.`);
        }
        continue;
      }
      await applyMigration(client, name, sql, checksum);
      process.stdout.write(`Applied ${name}\n`);
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Migration failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
