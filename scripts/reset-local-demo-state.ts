import { promises as fs } from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { Pool } from "pg";
import Redis from "ioredis";

import { defaultPolicyConfig } from "../src/lib/policy/engine";
import { getFortexaStoreDir } from "../src/lib/storage/paths";

export interface ResetOptions {
  dryRun?: boolean;
  allowLocalReset?: boolean; // Mock for process.env.FORTEXA_ALLOW_LOCAL_RESET
  yesFlag?: boolean; // Mock for process.argv.includes("--yes")
  databaseUrl?: string; // Mock for process.env.DATABASE_URL
  redisUrl?: string; // Mock for process.env.REDIS_URL
  sharedStatePath?: string; // Mock for process.env.FORTEXA_SHARED_STATE_PATH
  storeDir?: string; // Mock for store directory
  log?: (msg: string) => void;
  errorLog?: (msg: string) => void;
}

export function isLocalDatabaseUrl(dbUrl: string | undefined): boolean {
  if (!dbUrl) {
    return true; // No database configured is safe (local file fallback)
  }

  const trimmed = dbUrl.trim();
  if (!trimmed) {
    return true;
  }

  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      const hostname = parsed.hostname.toLowerCase();
      return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname === "[::1]" ||
        hostname === ""
      );
    } catch {
      return false; // Fail safe on invalid URL
    }
  }

  // Key-value style: e.g. "host=localhost port=5432"
  const hostMatch = trimmed.match(/(?:^|\s)host\s*=\s*([^\s]+)/);
  if (hostMatch) {
    const host = hostMatch[1].toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]"
    );
  }

  // If host is not specified, PG client defaults to local Unix socket or localhost
  return true;
}

export function isLocalRedisUrl(redisUrl: string | undefined): boolean {
  if (!redisUrl) {
    return true;
  }

  const trimmed = redisUrl.trim();
  if (!trimmed) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === ""
    );
  } catch {
    return false;
  }
}

export async function runReset(options: ResetOptions = {}): Promise<{ success: boolean; refusalReason?: string }> {
  const log = options.log ?? console.log;
  const errorLog = options.errorLog ?? console.error;

  // Resolve environment and flags
  const allowLocalReset = options.allowLocalReset ?? (process.env.FORTEXA_ALLOW_LOCAL_RESET === "true");
  const yesFlag = options.yesFlag ?? process.argv.includes("--yes");
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const storeDir = options.storeDir ?? getFortexaStoreDir();

  const rawSharedState = options.sharedStatePath ?? process.env.FORTEXA_SHARED_STATE_PATH;
  let sharedStatePath: string | null = null;
  if (rawSharedState?.trim()) {
    const configured = rawSharedState.trim();
    if (path.isAbsolute(configured)) {
      sharedStatePath = configured;
    } else {
      const relativeBase = process.env.VERCEL === "1" ? "/tmp" : process.cwd();
      sharedStatePath = path.join(relativeBase, configured);
    }
  }

  // Check Database URL Safety
  const isDbLocal = isLocalDatabaseUrl(databaseUrl);

  // Dry-run mode by default
  const isDryRun = options.dryRun ?? !(allowLocalReset && yesFlag);

  log(`=== Fortexa Local Demo State Reset (${isDryRun ? "DRY-RUN" : "APPLY MODE"}) ===\n`);

  // Target files collection
  const fileTargets = [
    path.join(storeDir, "audit.json"),
    path.join(storeDir, "policy.json"),
    path.join(storeDir, "policy-history.json"),
    path.join(storeDir, "submit-idempotency.json"),
    path.join(storeDir, "wallets.json"),
  ];
  if (sharedStatePath) {
    fileTargets.push(sharedStatePath);
  }

  log("[Target Files]");
  const existingFiles: string[] = [];
  for (const filePath of fileTargets) {
    try {
      const stat = await fs.stat(filePath);
      const relativePath = path.relative(process.cwd(), filePath);
      log(`- File: ${relativePath} (${stat.size} bytes) - WILL BE RESET/DELETED`);
      existingFiles.push(filePath);
    } catch {
      const relativePath = path.relative(process.cwd(), filePath);
      log(`- File: ${relativePath} (does not exist / clean)`);
    }
  }
  log("");

  // Target Database Tables collection
  const tables = [
    "fortexa_wallets",
    "fortexa_audit_entries",
    "fortexa_usage",
    "fortexa_policy_state",
    "fortexa_policy_history",
    "fortexa_submit_idempotency",
  ];

  let pool: Pool | null = null;
  const tableCounts: Record<string, string | number> = {};

  if (databaseUrl?.trim()) {
    log("[Target Database Tables]");
    try {
      pool = new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 1000,
      });

      for (const table of tables) {
        try {
          const res = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
          const count = parseInt(res.rows[0].count, 10);
          tableCounts[table] = count;
          log(`- Table: ${table} (${count} rows) - WILL BE TRUNCATED`);
        } catch {
          tableCounts[table] = "table does not exist";
          log(`- Table: ${table} (table does not exist / clean)`);
        }
      }
    } catch {
      log("- Database connection failed (could not check table row counts)");
    }
    log("");
  } else {
    log("[Target Database Tables]\n- No DATABASE_URL configured (database skipped)\n");
  }

  // Target Redis Keys collection
  let redisKeysCount: number | string = 0;
  let redisClient: Redis | null = null;
  let targetRedisKeys: string[] = [];

  if (redisUrl?.trim()) {
    log("[Target Redis Keys]");
    if (isLocalRedisUrl(redisUrl)) {
      try {
        redisClient = new Redis(redisUrl, {
          connectTimeout: 1000,
          maxRetriesPerRequest: 0,
          enableOfflineQueue: false,
        });
        targetRedisKeys = await redisClient.keys("fortexa:*");
        redisKeysCount = targetRedisKeys.length;
        log(`- Redis keys matching 'fortexa:*': ${redisKeysCount} keys found - WILL BE DELETED`);
      } catch {
        redisKeysCount = "Unable to connect";
        log(`- Redis keys matching 'fortexa:*': unable to query Redis`);
      }
    } else {
      redisKeysCount = "Non-local Redis URL (skipped)";
      log(`- Redis keys matching 'fortexa:*': non-local Redis skipped for safety`);
    }
    log("");
  }

  log("================================================\n");

  // Safety Refusals
  if (!isDbLocal) {
    const refusalReason = "DATABASE_URL points to a non-local database host. Destructive execution is blocked.";
    errorLog(`!!! REFUSAL: Execution BLOCKED !!!`);
    errorLog(`Reason: ${refusalReason}`);
    if (pool) {
      await pool.end().catch(() => {});
    }
    if (redisClient) {
      redisClient.disconnect();
    }
    return { success: false, refusalReason };
  }

  if (isDryRun) {
    let refusalReason = "";
    if (!allowLocalReset && !yesFlag) {
      refusalReason = "Missing env variable FORTEXA_ALLOW_LOCAL_RESET=true and CLI flag --yes.";
    } else if (!allowLocalReset) {
      refusalReason = "Missing env variable FORTEXA_ALLOW_LOCAL_RESET=true.";
    } else if (!yesFlag) {
      refusalReason = "Missing CLI flag --yes.";
    }

    log(`*** NO CHANGES WERE APPLIED (Dry-run mode) ***`);
    log("To perform the actual reset, ensure BOTH:");
    log("1. Environment variable FORTEXA_ALLOW_LOCAL_RESET=true is set.");
    log("2. CLI flag --yes is passed.\n");
    log("Command example:");
    log("FORTEXA_ALLOW_LOCAL_RESET=true npx tsx scripts/reset-local-demo-state.ts --yes");

    if (pool) {
      await pool.end().catch(() => {});
    }
    if (redisClient) {
      redisClient.disconnect();
    }
    return { success: false, refusalReason };
  }

  // Apply reset
  log(">>> Resetting local demo state...");

  // 1. Delete/Reset Files
  for (const filePath of fileTargets) {
    try {
      await fs.unlink(filePath);
      const relativePath = path.relative(process.cwd(), filePath);
      log(`[Files] Deleted file: ${relativePath}`);
    } catch {
      // Ignored if file does not exist
    }
  }

  // 2. Truncate DB Tables and Re-seed policy config
  if (pool) {
    for (const table of tables) {
      try {
        await pool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
        log(`[Database] Truncated table: ${table}`);
      } catch {
        // Ignored if table does not exist
      }
    }

    // Re-seed default policy state
    try {
      const now = new Date().toISOString();
      const policyJson = JSON.stringify(defaultPolicyConfig);

      // Check if fortexa_policy_state and fortexa_policy_history tables exist
      await pool.query(
        `INSERT INTO fortexa_policy_state (id, version, updated_at, policy)
         VALUES (1, 1, $1::timestamptz, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET version = 1, updated_at = $1::timestamptz, policy = $2::jsonb`,
        [now, policyJson]
      );

      await pool.query(
        `INSERT INTO fortexa_policy_history (version, updated_at, updated_by, policy)
         VALUES (1, $1::timestamptz, 'system-bootstrap', $2::jsonb)
         ON CONFLICT (version) DO NOTHING`,
        [now, policyJson]
      );

      log(`[Database] Re-seeded default policy configuration to version 1.`);
    } catch {
      // Ignore if tables are not found
    }

    await pool.end().catch(() => {});
  }

  // 3. Clear local Redis keys
  if (redisClient && targetRedisKeys.length > 0) {
    try {
      await redisClient.del(...targetRedisKeys);
      log(`[Redis] Deleted ${targetRedisKeys.length} keys matching 'fortexa:*'`);
    } catch {
      errorLog("[Redis] Failed to delete keys");
    }
  }
  if (redisClient) {
    redisClient.disconnect();
  }

  log("\nReset completed successfully!");
  return { success: true };
}

// Entrypoint trigger
async function main() {
  const isMain = process.argv[1] && (
    process.argv[1].endsWith("reset-local-demo-state.ts") ||
    process.argv[1].endsWith("reset-local-demo-state.js") ||
    process.argv[1].endsWith("reset-local-demo-state.mjs")
  );

  if (isMain) {
    const result = await runReset();
    if (!result.success) {
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error during state reset:", err);
  process.exit(1);
});
