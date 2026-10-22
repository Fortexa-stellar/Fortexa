import { promises as fs } from "node:fs";

import { checkReadiness, type ReadinessDeps, type ReadinessResult } from "@/lib/readiness/gate";
import { runWithDatabaseNoMigrate } from "@/lib/storage/db";
import { STORAGE_MIGRATIONS } from "@/lib/storage/migrations";
import { getFortexaStorePath } from "@/lib/storage/paths";
import {
  STELLAR_PUBLIC_NETWORK_PASSPHRASE,
  STELLAR_TESTNET_NETWORK_PASSPHRASE,
} from "@/lib/stellar/network";

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function usesDatabase(env: NodeJS.ProcessEnv) {
  return clean(env.DATABASE_URL) !== null;
}

/** Latest migration id this build expects. */
export function getExpectedMigrationId(): string {
  const last = STORAGE_MIGRATIONS[STORAGE_MIGRATIONS.length - 1];
  return last ? last.id : "none";
}

/**
 * Read-only migration check. It must NOT go through runWithDatabase(), which
 * applies pending migrations and would hide a stale schema.
 *
 * Returns the expected id only when every known migration is applied.
 * File-store mode has no schema, so there is nothing to migrate.
 */
export async function getAppliedMigrationId(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (!usesDatabase(env)) {
    return getExpectedMigrationId();
  }

  const db = await runWithDatabaseNoMigrate(async (pool) => {
    const result = await pool.query<{ id: string }>("SELECT id FROM fortexa_schema_migrations");
    return result.rows.map((row) => row.id);
  });

  if (!db.available) {
    return null;
  }

  const applied = new Set(db.value);
  return STORAGE_MIGRATIONS.every((migration) => applied.has(migration.id))
    ? getExpectedMigrationId()
    : null;
}

/**
 * Read-only policy store check.
 *
 * getPolicyConfig() silently bootstraps default policy rows when storage is
 * empty, so it can never tell us the store is missing. This reads the
 * persisted state without creating anything.
 */
export async function loadPolicyStore(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (usesDatabase(env)) {
    const db = await runWithDatabaseNoMigrate(async (pool) => {
      const result = await pool.query<{ version: number }>(
        "SELECT version FROM fortexa_policy_state WHERE id = 1"
      );
      return result.rows.length > 0;
    });

    // A configured but unreachable database must not pass via the file fallback.
    return db.available ? db.value === true : false;
  }

  try {
    const raw = await fs.readFile(getFortexaStorePath("policy.json"), "utf8");
    const parsed = JSON.parse(raw) as { policy?: unknown; version?: unknown };
    return Boolean(parsed.policy) && typeof parsed.version === "number";
  } catch {
    return false;
  }
}

export function getConfiguredPassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  return clean(env.STELLAR_NETWORK_PASSPHRASE);
}

/**
 * The passphrase this deployment is supposed to use.
 * FORTEXA_EXPECTED_NETWORK_PASSPHRASE wins when set; otherwise production
 * expects the public network and everything else expects testnet.
 */
export function getExpectedPassphrase(env: NodeJS.ProcessEnv = process.env): string {
  return (
    clean(env.FORTEXA_EXPECTED_NETWORK_PASSPHRASE) ??
    (env.NODE_ENV === "production"
      ? STELLAR_PUBLIC_NETWORK_PASSPHRASE
      : STELLAR_TESTNET_NETWORK_PASSPHRASE)
  );
}

export function defaultReadinessDeps(env: NodeJS.ProcessEnv = process.env): ReadinessDeps {
  return {
    getAppliedMigrationId: () => getAppliedMigrationId(env),
    expectedMigrationId: getExpectedMigrationId(),
    loadPolicyStore: () => loadPolicyStore(env),
    getConfiguredPassphrase: () => getConfiguredPassphrase(env),
    expectedPassphrase: getExpectedPassphrase(env),
  };
}

/** One readiness result for health and for the pay/decision routes. */
export function getReadiness(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ReadinessDeps> = {}
): Promise<ReadinessResult> {
  return checkReadiness({ ...defaultReadinessDeps(env), ...overrides });
}
