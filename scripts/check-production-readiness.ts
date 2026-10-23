import { loadEnvConfig } from "@next/env";

import {
  checkProductionReadiness,
  formatProductionReadinessReport,
} from "../src/lib/readiness/production";

loadEnvConfig(process.cwd());

import { Pool } from "pg";
import { STORAGE_MIGRATIONS } from "../src/lib/storage/migrations";

async function main() {
  let appliedMigrationId: string | undefined = undefined;

  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl) {
    const pool = new Pool({
      connectionString: dbUrl,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    try {
      const result = await pool.query<{ id: string }>(`SELECT id FROM fortexa_schema_migrations`);
      const appliedSet = new Set(result.rows.map((r) => r.id));
      for (let i = STORAGE_MIGRATIONS.length - 1; i >= 0; i--) {
        if (appliedSet.has(STORAGE_MIGRATIONS[i].id)) {
          appliedMigrationId = STORAGE_MIGRATIONS[i].id;
          break;
        }
      }
      if (!appliedMigrationId && result.rows.length === 0) {
        appliedMigrationId = "none";
      }
    } catch {
      // Ignored if table doesn't exist
    } finally {
      await pool.end().catch(() => {});
    }
  }

  const report = checkProductionReadiness(process.env, { appliedMigrationId });
  const output = formatProductionReadinessReport(report);

  if (!report.ok) {
    console.error(output);
    process.exitCode = 1;
  } else {
    console.log(output);
  }
}

main().catch((error) => {
  console.error("Production readiness check failed unexpectedly:", error);
  process.exitCode = 1;
});
