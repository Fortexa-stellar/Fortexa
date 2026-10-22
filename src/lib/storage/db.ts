import { Pool } from "pg";

import { logWarn } from "@/lib/observability/logger";
import { STORAGE_MIGRATIONS } from "@/lib/storage/migrations";

type DatabaseExecution<T> =
  | {
      available: true;
      value: T;
    }
  | {
      available: false;
    };

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;

export class DatabaseMigrationError extends Error {
  constructor(cause: unknown) {
    super("Database migrations failed; the application cannot safely serve requests.", { cause });
    this.name = "DatabaseMigrationError";
  }
}

function getDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim();
  return value && value.length > 0 ? value : null;
}

function getPool() {
  const url = getDatabaseUrl();
  if (!url) {
    return null;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: url,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

async function ensureSchema(targetPool: Pool) {
  if (!initPromise) {
    initPromise = (async () => {
      const client = await targetPool.connect();
      try {
        await client.query("SELECT pg_advisory_lock(hashtext('fortexa-storage-migrations'))");
        await client.query(`
          CREATE TABLE IF NOT EXISTS fortexa_schema_migrations (
            id TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        const applied = await client.query<{ id: string }>(
          `SELECT id FROM fortexa_schema_migrations`
        );
        const appliedSet = new Set(applied.rows.map((row) => row.id));

        for (const migration of STORAGE_MIGRATIONS) {
          if (appliedSet.has(migration.id)) continue;

          await client.query("BEGIN");
          try {
            await client.query(migration.sql);
            await client.query(`INSERT INTO fortexa_schema_migrations (id) VALUES ($1)`, [
              migration.id,
            ]);
            await client.query("COMMIT");
            appliedSet.add(migration.id);
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          }
        }
      } finally {
        await client
          .query("SELECT pg_advisory_unlock(hashtext('fortexa-storage-migrations'))")
          .catch(() => undefined);
        client.release();
      }
    })();
  }

  await initPromise;
}

export async function ensureDatabaseReady() {
  const targetPool = getPool();
  if (!targetPool) return;

  try {
    await ensureSchema(targetPool);
  } catch (error) {
    throw new DatabaseMigrationError(error);
  }
}

export async function getDatabaseMigrationStatus() {
  const expectedIds = STORAGE_MIGRATIONS.map((migration) => migration.id);
  const expectedId = expectedIds.at(-1) ?? null;
  const targetPool = getPool();
  if (!targetPool) {
    return { configured: false, ready: true, appliedId: null, expectedId };
  }

  try {
    const result = await targetPool.query<{ id: string }>(
      "SELECT id FROM fortexa_schema_migrations"
    );
    const appliedIds = new Set(result.rows.map((row) => row.id));
    const appliedId = [...expectedIds].reverse().find((id) => appliedIds.has(id)) ?? null;
    const ready = expectedIds.every((id) => appliedIds.has(id));
    return { configured: true, ready, appliedId, expectedId };
  } catch {
    return { configured: true, ready: false, appliedId: null, expectedId };
  }
}

export async function runWithDatabase<T>(
  operationName: string,
  action: (targetPool: Pool) => Promise<T>
): Promise<DatabaseExecution<T>> {
  const targetPool = getPool();
  if (!targetPool) {
    return { available: false };
  }

  try {
    await ensureSchema(targetPool);
  } catch (error) {
    throw new DatabaseMigrationError(error);
  }

  try {
    const value = await action(targetPool);
    return { available: true, value };
  } catch (error) {
    logWarn("Database operation failed, falling back to file store", {
      operationName,
      detail: error instanceof Error ? error.message : "unknown",
    });

    return { available: false };
  }
}
export async function runWithDatabaseNoMigrate<T>(
  action: (targetPool: Pool) => Promise<T>
): Promise<DatabaseExecution<T>> {
  const targetPool = getPool();
  if (!targetPool) {
    return { available: false };
  }

  try {
    const value = await action(targetPool);
    return { available: true, value };
  } catch {
    return { available: false };
  }
}

export async function runWithDatabaseStrict<T>(
  operationName: string,
  action: (targetPool: Pool) => Promise<T>
): Promise<DatabaseExecution<T>> {
  const targetPool = getPool();
  if (!targetPool) {
    return { available: false };
  }

  try {
    await ensureSchema(targetPool);
    const value = await action(targetPool);
    return { available: true, value };
  } catch (error) {
    logWarn("Strict database operation failed", {
      operationName,
      detail: error instanceof Error ? error.message : "unknown",
    });
    throw error;
  }
}

export async function __resetDatabaseForTests() {
  initPromise = null;
  if (pool) {
    await pool.end().catch(() => undefined);
  }
  pool = null;
}
