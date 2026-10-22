import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import { GENESIS_HASH, computeEntryHash } from "@/lib/audit/hash-chain";
import { runWithDatabase, runWithDatabaseStrict } from "@/lib/storage/db";
import { getFortexaStoreDir, getFortexaStorePath, resolveContainedStorePath } from "@/lib/storage/paths";
import type { ContainedStorePath } from "@/lib/storage/paths";
import type { AuditEntry, DailyUsage, DecisionType } from "@/lib/types/domain";

type AuditStoreFile = {
  auditByUser: Record<string, AuditEntry[]>;
  usageByUser: Record<string, DailyUsage>;
};

export const AUDIT_EXPORT_MAX_ROWS = 10000;
const AUDIT_STORE_FILE_NAME = "audit.json";

export type AuditFilter = {
  from?: string;
  to?: string;
  decision?: string;
  domain?: string;
  actionId?: string;
};

const VALID_DECISIONS: DecisionType[] = [
  "APPROVE",
  "WARN",
  "REQUIRE_APPROVAL",
  "BLOCK",
];
const VALID_DECISION_SET = new Set<string>(VALID_DECISIONS);

const REDACTED = "[REDACTED]";

export function validateAuditFilter(filter: AuditFilter): string | null {
  if (filter.from !== undefined && isNaN(Date.parse(filter.from))) {
    return "Invalid 'from' date. Use ISO 8601 format (e.g. 2025-01-01T00:00:00Z).";
  }
  if (filter.to !== undefined && isNaN(Date.parse(filter.to))) {
    return "Invalid 'to' date. Use ISO 8601 format (e.g. 2025-01-01T00:00:00Z).";
  }
  if (
    filter.decision !== undefined &&
    !VALID_DECISION_SET.has(filter.decision)
  ) {
    return `Invalid decision '${filter.decision}'. Must be one of: ${VALID_DECISIONS.join(", ")}.`;
  }
  return null;
}

const CREDENTIAL_KEY_PATTERN =
  /(secret|token|password|passwd|api[_-]?key|apikey|authorization|auth|credential|private[_-]?key|access[_-]?key|bearer|cookie|session)/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redactValue(nested);
      }
    }
    return result;
  }
  return value;
}

export function redactAuditEntry(entry: AuditEntry): AuditEntry {
  return redactValue(entry) as AuditEntry;
}

export type AuditExportResult =
  | { ok: true; entries: AuditEntry[] }
  | { ok: false; error: string; code: "CHAIN_INVALID" | "ROW_CAP_EXCEEDED" };

export async function exportVerifiedAuditEntries(
  userId: string,
  filter?: AuditFilter,
): Promise<AuditExportResult> {
  const entries = await listAuditEntries(userId, filter);
  return verifyAndRedactExport(entries);
}

export function verifyAndRedactExport(
  entries: AuditEntry[],
): AuditExportResult {
  if (entries.length > AUDIT_EXPORT_MAX_ROWS) {
    return {
      ok: false,
      code: "ROW_CAP_EXCEEDED",
      error: `Audit export exceeds maximum of ${AUDIT_EXPORT_MAX_ROWS} rows.`,
    };
  }

  const ordered = [...entries].sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );

  const verification = verifyHashChain(ordered);
  if (!verification.valid) {
    return {
      ok: false,
      code: "CHAIN_INVALID",
      error: verification.error ?? "Audit hash chain failed verification.",
    };
  }

  return { ok: true, entries: ordered.map((entry) => redactAuditEntry(entry)) };
}

function applyFilter(
  entries: AuditEntry[],
  filter?: AuditFilter,
): AuditEntry[] {
  if (!filter) return entries;

  const { from, to, decision, domain, actionId } = filter;

  return entries.filter((entry) => {
    if (from !== undefined && entry.timestamp < from) return false;
    if (to !== undefined && entry.timestamp > to) return false;
    if (decision !== undefined && entry.decision !== decision) return false;
    if (
      domain !== undefined &&
      !entry.action.domain.toLowerCase().includes(domain.toLowerCase())
    )
      return false;
    if (
      actionId !== undefined &&
      !entry.action.id.toLowerCase().includes(actionId.toLowerCase())
    )
      return false;
    return true;
  });
}

const storePath = getFortexaStorePath(AUDIT_STORE_FILE_NAME);
let fallbackMutationQueue = Promise.resolve();

function withFallbackMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = fallbackMutationQueue.then(operation, operation);
  fallbackMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

const baselineUsage: DailyUsage = {
  spentXLM: 0,
  toolCalls: 0,
  lastUpdated: new Date().toISOString(),
};

/**
 * Opens the audit file store, creating it if missing, and returns its path.
 * The path comes only from resolveContainedStorePath, so a name that escapes
 * the data directory (`..`, an absolute path, or a symlink pointing outside)
 * throws StoragePathError before anything is read or written.
 */
export async function openAuditFileStore(fileName: string = AUDIT_STORE_FILE_NAME): Promise<ContainedStorePath> {
  await fs.mkdir(getFortexaStoreDir(), { recursive: true });
  const storePath = await resolveContainedStorePath(fileName);
  try {
    await fs.access(storePath);
  } catch {
    const initial: AuditStoreFile = {
      auditByUser: {},
      usageByUser: {},
    };
    await fs.writeFile(storePath, JSON.stringify(initial, null, 2), "utf8");
  }
  return storePath;
}

async function readStore(): Promise<AuditStoreFile> {
  const storePath = await openAuditFileStore();
  const raw = await fs.readFile(storePath, "utf8");
  return JSON.parse(raw) as AuditStoreFile;
}

async function writeStore(store: AuditStoreFile) {
  const tempPath = `${storePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tempPath, storePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function nextAuditTimestamp(timestamp: string, previousTimestamp?: string) {
  const requested = Date.parse(timestamp);
  const previous = previousTimestamp ? Date.parse(previousTimestamp) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(requested, previous + 1)).toISOString();
}

export async function getAuditEntryById(userId: string, entryId: string) {
  const entries = await listAuditEntries(userId);
  return entries.find((entry) => entry.id === entryId);
}

export async function listAuditEntries(userId: string, filter?: AuditFilter) {
  const db = await runWithDatabase("listAuditEntries", async (pool) => {
    const result = await pool.query<{ payload: AuditEntry }>(
      `
        SELECT payload
        FROM fortexa_audit_entries
        WHERE user_id = $1
        ORDER BY timestamp DESC, chain_sequence DESC
      `,
      [userId],
    );

    return applyFilter(
      result.rows.map((row) => row.payload),
      filter,
    );
  });

  if (db.available) {
    return db.value;
  }

  const store = await readStore();
  const entries = store.auditByUser[userId] ?? [];
  return applyFilter(
    [...entries].sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
    ),
    filter,
  );
}

export async function listAllAuditEntriesByUser(filter?: AuditFilter) {
  const db = await runWithDatabase(
    "listAllAuditEntriesByUser",
    async (pool) => {
      const result = await pool.query<{ user_id: string; payload: AuditEntry }>(
        `
        SELECT user_id, payload
        FROM fortexa_audit_entries
        ORDER BY timestamp DESC, chain_sequence DESC
      `,
      );

      const grouped: Record<string, AuditEntry[]> = {};

      for (const row of result.rows) {
        grouped[row.user_id] ??= [];
        grouped[row.user_id].push(row.payload);
      }

      for (const userId of Object.keys(grouped)) {
        grouped[userId] = applyFilter(grouped[userId], filter);
      }

      return grouped;
    },
  );

  if (db.available) {
    return db.value;
  }

  const store = await readStore();
  const result: Record<string, AuditEntry[]> = {};

  for (const [userId, entries] of Object.entries(store.auditByUser)) {
    const filtered = applyFilter(
      [...entries].sort((a, b) =>
        a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0,
      ),
      filter,
    );
    if (filtered.length > 0) {
      result[userId] = filtered;
    }
  }

  return result;
}

export async function appendAuditEntry(userId: string, entry: AuditEntry) {
  const db = await runWithDatabaseStrict("appendAuditEntry", async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);

      const prevResult = await client.query<{ entry_hash: string; timestamp: string; chain_sequence: string }>(
        `
          SELECT entry_hash, timestamp, chain_sequence
          FROM fortexa_audit_entries
          WHERE user_id = $1
            AND entry_hash IS NOT NULL
          ORDER BY chain_sequence DESC
          LIMIT 1
        `,
        [userId],
      );

      const previous = prevResult.rows[0];
      const previousHash = previous?.entry_hash ?? GENESIS_HASH;
      const timestamp = nextAuditTimestamp(entry.timestamp, previous?.timestamp);
      const sequenceResult = await client.query<{ next_sequence: string }>(
        `SELECT COALESCE(MAX(chain_sequence), 0) + 1 AS next_sequence FROM fortexa_audit_entries WHERE user_id = $1`,
        [userId],
      );
      const sequence = Number(sequenceResult.rows[0]?.next_sequence ?? 1);
      const entryHash = computeEntryHash({ ...entry, timestamp, previousHash });
      const enriched: AuditEntry = { ...entry, timestamp, previousHash, entryHash };

      await client.query(
        `
          INSERT INTO fortexa_audit_entries (id, user_id, timestamp, payload, entry_hash, chain_sequence)
          VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5, $6)
        `,
        [enriched.id, userId, enriched.timestamp, JSON.stringify(enriched), enriched.entryHash, sequence],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  if (db.available) {
    return;
  }

  await withFallbackMutationLock(async () => {
    const store = await readStore();
    const existing = store.auditByUser[userId] ?? [];
    const lastHashed = [...existing].reverse().find((storedEntry) => storedEntry.entryHash);
    const previousHash = lastHashed?.entryHash ?? GENESIS_HASH;
    const timestamp = nextAuditTimestamp(entry.timestamp, existing.at(-1)?.timestamp);
    const entryHash = computeEntryHash({ ...entry, timestamp, previousHash });
    const enriched: AuditEntry = { ...entry, timestamp, previousHash, entryHash };

    existing.push(enriched);
    store.auditByUser[userId] = existing;
    await writeStore(store);
  });
}

export async function getDailyUsage(userId: string) {
  const db = await runWithDatabase("getDailyUsage", async (pool) => {
    const result = await pool.query<{
      spent_xlm: number;
      tool_calls: number;
      last_updated: string;
    }>(
      `
        SELECT spent_xlm, tool_calls, last_updated
        FROM fortexa_usage
        WHERE user_id = $1
      `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      return {
        ...baselineUsage,
        lastUpdated: new Date().toISOString(),
      };
    }

    return {
      spentXLM: row.spent_xlm,
      toolCalls: row.tool_calls,
      lastUpdated: new Date(row.last_updated).toISOString(),
    };
  });

  if (db.available) {
    return db.value;
  }

  const store = await readStore();
  return (
    store.usageByUser[userId] ?? {
      ...baselineUsage,
      lastUpdated: new Date().toISOString(),
    }
  );
}

export async function consumeUsage(userId: string, amountXLM: number) {
  const db = await runWithDatabase("consumeUsage", async (pool) => {
    const current = await pool.query<{
      spent_xlm: number;
      tool_calls: number;
    }>(
      `
        SELECT spent_xlm, tool_calls
        FROM fortexa_usage
        WHERE user_id = $1
      `,
      [userId],
    );

    const spentXLM = (current.rows[0]?.spent_xlm ?? 0) + amountXLM;
    const toolCalls = (current.rows[0]?.tool_calls ?? 0) + 1;
    const updatedAt = new Date().toISOString();

    await pool.query(
      `
        INSERT INTO fortexa_usage (user_id, spent_xlm, tool_calls, last_updated)
        VALUES ($1, $2, $3, $4::timestamptz)
        ON CONFLICT (user_id)
        DO UPDATE SET
          spent_xlm = EXCLUDED.spent_xlm,
          tool_calls = EXCLUDED.tool_calls,
          last_updated = EXCLUDED.last_updated
      `,
      [userId, spentXLM, toolCalls, updatedAt],
    );
  });

  if (db.available) {
    return;
  }

  await withFallbackMutationLock(async () => {
    const store = await readStore();
    const current = store.usageByUser[userId] ?? {
      ...baselineUsage,
      lastUpdated: new Date().toISOString(),
    };

    store.usageByUser[userId] = {
      spentXLM: current.spentXLM + amountXLM,
      toolCalls: current.toolCalls + 1,
      lastUpdated: new Date().toISOString(),
    };

    await writeStore(store);
  });
}

export async function resetAuditState(userId: string) {
  const db = await runWithDatabase("resetAuditState", async (pool) => {
    await pool.query("DELETE FROM fortexa_audit_entries WHERE user_id = $1", [
      userId,
    ]);
    await pool.query(
      `
        INSERT INTO fortexa_usage (user_id, spent_xlm, tool_calls, last_updated)
        VALUES ($1, 0, 0, $2::timestamptz)
        ON CONFLICT (user_id)
        DO UPDATE SET
          spent_xlm = EXCLUDED.spent_xlm,
          tool_calls = EXCLUDED.tool_calls,
          last_updated = EXCLUDED.last_updated
      `,
      [userId, new Date().toISOString()],
    );
  });

  if (db.available) {
    return;
  }

  await withFallbackMutationLock(async () => {
    const store = await readStore();
    store.auditByUser[userId] = [];
    store.usageByUser[userId] = {
      ...baselineUsage,
      lastUpdated: new Date().toISOString(),
    };
    await writeStore(store);
  });
}
