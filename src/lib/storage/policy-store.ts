import { promises as fs } from "node:fs";

import {
  defaultPolicyConfig,
  readAmountStroops,
  validateNoDuplicateRules,
} from "@/lib/policy/engine";
import { runWithDatabase } from "@/lib/storage/db";
import { getFortexaStoreDir, getFortexaStorePath } from "@/lib/storage/paths";
import type { PolicyConfig } from "@/lib/types/domain";

const storePath = getFortexaStorePath("policy.json");
const historyPath = getFortexaStorePath("policy-history.json");

type PolicyStoreFile = {
  policy: PolicyConfig;
  updatedAt: string;
  version: number;
};

/**
 * Raised when a policy save is rejected because the submitted `expectedVersion`
 * does not match the current server version. Carries the current version
 * metadata so the API route can return a 409 Conflict with reconciliation info.
 *
 * History is never appended in this path — a conflicting save is a no-op.
 */
export class PolicyVersionConflict extends Error {
  public readonly currentVersion: number;
  public readonly currentUpdatedAt: string | null;
  public readonly expectedVersion: number;

  constructor(input: {
    currentVersion: number;
    currentUpdatedAt: string | null;
    expectedVersion: number;
  }) {
    super(
      `Policy version conflict: expected v${input.expectedVersion} but current is v${input.currentVersion}.`
    );
    this.name = "PolicyVersionConflict";
    this.currentVersion = input.currentVersion;
    this.currentUpdatedAt = input.currentUpdatedAt;
    this.expectedVersion = input.expectedVersion;
  }
}

/**
 * Raised when a policy document cannot be migrated onto the current schema.
 * The previous policy remains active; the failing version is reported back
 * to the caller so the API and the import UI can show the same message.
 */
export class PolicyMigrationError extends Error {
  public readonly failingVersion: number | null;
  public readonly issues: { path: string; message: string }[];

  constructor(input: {
    error: string;
    failingVersion?: number | null;
    issues?: { path: string; message: string }[];
  }) {
    super(input.error);
    this.name = "PolicyMigrationError";
    this.failingVersion = input.failingVersion ?? null;
    this.issues = input.issues ?? [];
  }
}

type PolicyHistoryEntry = {
  version: number;
  updatedAt: string;
  updatedBy?: string;
  policy: PolicyConfig;
};

type PolicyHistoryFile = {
  entries: PolicyHistoryEntry[];
};

async function ensureStore() {
  await fs.mkdir(getFortexaStoreDir(), { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    const initial: PolicyStoreFile = {
      policy: defaultPolicyConfig,
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    await fs.writeFile(storePath, JSON.stringify(initial, null, 2), "utf8");
  }

  try {
    await fs.access(historyPath);
  } catch {
    const initialHistory: PolicyHistoryFile = {
      entries: [
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: "system-bootstrap",
          policy: defaultPolicyConfig,
        },
      ],
    };

    await fs.writeFile(historyPath, JSON.stringify(initialHistory, null, 2), "utf8");
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(storePath, "utf8");

  try {
    return JSON.parse(raw) as Partial<PolicyStoreFile>;
  } catch {
    const reset: PolicyStoreFile = {
      policy: defaultPolicyConfig,
      updatedAt: new Date().toISOString(),
      version: 1,
    };

    await fs.writeFile(storePath, JSON.stringify(reset, null, 2), "utf8");
    return reset;
  }
}

async function readHistoryStore() {
  await ensureStore();
  const raw = await fs.readFile(historyPath, "utf8");

  try {
    return JSON.parse(raw) as Partial<PolicyHistoryFile>;
  } catch {
    const reset: PolicyHistoryFile = {
      entries: [
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          updatedBy: "system-reset",
          policy: defaultPolicyConfig,
        },
      ],
    };

    await fs.writeFile(historyPath, JSON.stringify(reset, null, 2), "utf8");
    return reset;
  }
}

function stroopField(displayXlm: number): string | undefined {
  const stroops = readAmountStroops(displayXlm);
  return stroops === null ? undefined : stroops.toString();
}

export function normalizePolicy(policy?: Partial<PolicyConfig>): PolicyConfig {
  return {
    allowedDomains: policy?.allowedDomains ?? defaultPolicyConfig.allowedDomains,
    blockedDomains: policy?.blockedDomains ?? defaultPolicyConfig.blockedDomains,
    allowedTools: policy?.allowedTools ?? defaultPolicyConfig.allowedTools,
    blockedTools: policy?.blockedTools ?? defaultPolicyConfig.blockedTools,
    perTxCapXLM: policy?.perTxCapXLM ?? defaultPolicyConfig.perTxCapXLM,
    dailyCapXLM: policy?.dailyCapXLM ?? defaultPolicyConfig.dailyCapXLM,
    perTxCapStroops: stroopField(policy?.perTxCapXLM ?? defaultPolicyConfig.perTxCapXLM),
    dailyCapStroops: stroopField(policy?.dailyCapXLM ?? defaultPolicyConfig.dailyCapXLM),
    maxToolCallsPerDay: policy?.maxToolCallsPerDay ?? defaultPolicyConfig.maxToolCallsPerDay,
    riskThreshold: policy?.riskThreshold ?? defaultPolicyConfig.riskThreshold,
    allowedHours: policy?.allowedHours ?? defaultPolicyConfig.allowedHours,
    memoRequiredDestinations:
      policy?.memoRequiredDestinations ?? defaultPolicyConfig.memoRequiredDestinations ?? [],
  };
}

/**
 * Run the migration chain on a candidate document before any write.
 * Throws `PolicyMigrationError` when the document cannot be migrated
 * cleanly onto the current schema, leaving the previous policy active.
 */
export function migratePolicyDocument(raw: unknown): PolicyConfig {
  const result = parseStoredPolicy(raw);
  if (!result.ok) {
    throw new PolicyMigrationError({
      error: result.error,
      failingVersion: result.version ?? null,
      issues: result.issues,
    });
  }
  return result.policy;
}

async function writeStore(nextPolicy: PolicyConfig, nextVersion: number) {
  const next: PolicyStoreFile = {
    policy: nextPolicy,
    updatedAt: new Date().toISOString(),
    version: nextVersion,
  };

  await ensureStore();
  const tempPath = `${storePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tempPath, storePath);

  return next;
}

async function writeHistory(entries: PolicyHistoryEntry[]) {
  const next: PolicyHistoryFile = { entries };

  await ensureStore();
  const tempPath = `${historyPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tempPath, historyPath);
}

async function ensureDbPolicyState() {
  return runWithDatabase("ensureDbPolicyState", async (pool) => {
    const state = await pool.query<{
      version: number;
    }>(
      `
        SELECT version
        FROM fortexa_policy_state
        WHERE id = 1
      `
    );

    if (state.rows[0]) {
      return;
    }

    const now = new Date().toISOString();

    await pool.query(
      `
        INSERT INTO fortexa_policy_state (id, version, updated_at, policy)
        VALUES (1, 1, $1::timestamptz, $2::jsonb)
      `,
      [now, JSON.stringify(defaultPolicyConfig)]
    );

    await pool.query(
      `
        INSERT INTO fortexa_policy_history (version, updated_at, updated_by, policy)
        VALUES (1, $1::timestamptz, 'system-bootstrap', $2::jsonb)
        ON CONFLICT (version) DO NOTHING
      `,
      [now, JSON.stringify(defaultPolicyConfig)]
    );
  });
}

export async function getPolicyConfig() {
  const initialized = await ensureDbPolicyState();
  if (initialized.available) {
    const db = await runWithDatabase("getPolicyConfig", async (pool) => {
      const result = await pool.query<{
        policy: PolicyConfig;
        updated_at: string;
        version: number;
      }>(
        `
          SELECT policy, updated_at, version
          FROM fortexa_policy_state
          WHERE id = 1
        `
      );

      const row = result.rows[0];
      if (!row) {
        return {
          policy: normalizePolicy(defaultPolicyConfig),
          updatedAt: null,
          version: 1,
        };
      }

      return {
        policy: normalizePolicy(row.policy),
        updatedAt: new Date(row.updated_at).toISOString(),
        version: row.version ?? 1,
      };
    });

    if (db.available) {
      return db.value;
    }
  }

  const store = await readStore();
  return {
    policy: normalizePolicy(store.policy),
    updatedAt: store.updatedAt ?? null,
    version: store.version ?? 1,
  };
}

export async function updatePolicyConfig(
  nextPolicy: PolicyConfig,
  updatedBy?: string,
  options?: { expectedVersion?: number }
) {
  const expectedVersion = options?.expectedVersion;
  const initialized = await ensureDbPolicyState();
  if (initialized.available) {
    const db = await runWithDatabase("updatePolicyConfig", async (pool) => {
      const now = new Date().toISOString();
      const normalized = normalizePolicy(nextPolicy);
      validateNoDuplicateRules(normalized);

      const current = await pool.query<{
        version: number;
        updated_at: string;
      }>(
        `
          SELECT version, updated_at
          FROM fortexa_policy_state
          WHERE id = 1
        `
      );

      const currentRow = current.rows[0];
      const currentVersion = currentRow?.version ?? 1;
      const currentUpdatedAt = currentRow ? new Date(currentRow.updated_at).toISOString() : null;

      if (typeof expectedVersion === "number" && expectedVersion !== currentVersion) {
        throw new PolicyVersionConflict({
          currentVersion,
          currentUpdatedAt,
          expectedVersion,
        });
      }

      // Atomic compare-and-swap: refuse to overwrite if the version changed
      // between the read above and this update (another writer won the race).
      const nextVersion = currentVersion + 1;

      const updateResult =
        expectedVersion === undefined
          ? await pool.query(
              `
              UPDATE fortexa_policy_state
              SET version = $1,
                  updated_at = $2::timestamptz,
                  policy = $3::jsonb
              WHERE id = 1
            `,
              [nextVersion, now, JSON.stringify(normalized)]
            )
          : await pool.query(
              `
              UPDATE fortexa_policy_state
              SET version = $1,
                  updated_at = $2::timestamptz,
                  policy = $3::jsonb
              WHERE id = 1 AND version = $4
            `,
              [nextVersion, now, JSON.stringify(normalized), expectedVersion]
            );

      if (updateResult.rowCount === 0) {
        // We expected to find version = expectedVersion but it changed under us.
        // Re-read to report the new current version back to the caller.
        const refreshed = await pool.query<{
          version: number;
          updated_at: string;
        }>(
          `
            SELECT version, updated_at
            FROM fortexa_policy_state
            WHERE id = 1
          `
        );

        const refreshedRow = refreshed.rows[0];
        throw new PolicyVersionConflict({
          currentVersion: refreshedRow?.version ?? currentVersion,
          currentUpdatedAt: refreshedRow
            ? new Date(refreshedRow.updated_at).toISOString()
            : currentUpdatedAt,
          expectedVersion: expectedVersion ?? currentVersion,
        });
      }

      // Only after the state UPDATE succeeded do we append to history. This
      // guarantees conflicting saves never pollute the version history.
      await pool.query(
        `
          INSERT INTO fortexa_policy_history (version, updated_at, updated_by, policy)
          VALUES ($1, $2::timestamptz, $3, $4::jsonb)
        `,
        [nextVersion, now, updatedBy ?? null, JSON.stringify(normalized)]
      );

      return {
        policy: normalized,
        updatedAt: now,
        version: nextVersion,
      };
    });

    if (db.available) {
      return db.value;
    }
  }

  // File fallback: read the live store first so the precondition reflects the
  // latest persisted state. The classic check-then-write race window remains,
  // which is acceptable for a single-node fallback.
  const current = await getPolicyConfig();

  if (typeof expectedVersion === "number" && expectedVersion !== (current.version ?? 1)) {
    throw new PolicyVersionConflict({
      currentVersion: current.version ?? 1,
      currentUpdatedAt: current.updatedAt ?? null,
      expectedVersion,
    });
  }

  const historyStore = await readHistoryStore();
  const nextVersion = (current.version ?? 1) + 1;
  const normalized = normalizePolicy(nextPolicy);
  validateNoDuplicateRules(normalized);

  const entry: PolicyHistoryEntry = {
    version: nextVersion,
    updatedAt: new Date().toISOString(),
    updatedBy,
    policy: normalized,
  };

  const nextEntries = [...(historyStore.entries ?? []), entry];
  await writeHistory(nextEntries);

  return writeStore(normalized, nextVersion);
}

export async function getPolicyHistory(limit = 20) {
  const initialized = await ensureDbPolicyState();
  if (initialized.available) {
    const db = await runWithDatabase("getPolicyHistory", async (pool) => {
      const maxLimit = Math.max(1, limit);
      const result = await pool.query<{
        version: number;
        updated_at: string;
        updated_by: string | null;
        policy: PolicyConfig;
      }>(
        `
          SELECT version, updated_at, updated_by, policy
          FROM fortexa_policy_history
          ORDER BY version DESC
          LIMIT $1
        `,
        [maxLimit]
      );

      return result.rows.map((row) => ({
        version: row.version,
        updatedAt: new Date(row.updated_at).toISOString(),
        updatedBy: row.updated_by ?? undefined,
        policy: normalizePolicy(row.policy),
      }));
    });

    if (db.available) {
      return db.value;
    }
  }

  const history = await readHistoryStore();
  const entries = [...(history.entries ?? [])].sort((a, b) => b.version - a.version);
  return entries.slice(0, Math.max(1, limit)).map((entry) => ({
    version: entry.version,
    updatedAt: entry.updatedAt,
    updatedBy: entry.updatedBy,
    policy: normalizePolicy(entry.policy),
  }));
}

export async function rollbackPolicyVersion(version: number, updatedBy?: string) {
  const history = await getPolicyHistory(100);
  const target = history.find((entry) => entry.version === version);

  if (!target) {
    throw new Error(`Policy version v${version} not found in history.`);
  }

  return updatePolicyConfig(target.policy, updatedBy ?? "rollback");
}
