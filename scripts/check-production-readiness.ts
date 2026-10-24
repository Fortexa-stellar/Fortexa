import { loadEnvConfig } from "@next/env";

import {
  checkProductionReadiness,
  formatProductionReadinessReport,
} from "../src/lib/readiness/production";

loadEnvConfig(process.cwd());

import { Pool } from "pg";
import { STORAGE_MIGRATIONS } from "../src/lib/storage/migrations";

// CI fixture mode: when PRODUCTION_READINESS_FIXTURE is set, the checker runs
// against a safe, non-secret environment snapshot instead of the real process env.
// Supported values:
//   "valid"   - a configuration that must pass the readiness check
//   "invalid" - a configuration that must fail the readiness check
// No database connection is attempted in fixture mode.
const FIXTURE_ENVS: Record<string, NodeJS.ProcessEnv> = {
  valid: {
    NODE_ENV: "production",
    APP_URL: "https://app.fortexa.invalid",
    DATABASE_URL: "",
    DATABASE_SSL: "false",
    SESSION_SECRET: "fixture-session-secret-not-a-real-secret-0123456789abcdef",
  },
  invalid: {
    NODE_ENV: "production",
    APP_URL: "http://localhost:3000",
    DATABASE_URL: "",
    DATABASE_SSL: "false",
    SESSION_SECRET: "",
  },
};

async function main() {
  const fixtureName = process.env.PRODUCTION_READINESS_FIXTURE?.trim();

  if (fixtureName) {
    const fixtureEnv = FIXTURE_ENVS[fixtureName];
    if (!fixtureEnv) {
      console.error(
        `Unknown PRODUCTION_READINESS_FIXTURE "${fixtureName}". Expected one of: ${Object.keys(FIXTURE_ENVS).join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }

    const report = checkProductionReadiness(fixtureEnv, { appliedMigrationId: "none" });
    const output = formatProductionReadinessReport(report);

    if (fixtureName === "valid") {
      if (!report.ok) {
        console.error(`Fixture "valid" was expected to pass but failed:\n${output}`);
        process.exitCode = 1;
        return;
      }
      console.log(output);
      return;
    }

    if (fixtureName === "invalid") {
      if (report.ok) {
        console.error(`Fixture "invalid" was expected to fail but passed:\n${output}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Fixture "invalid" failed as expected:\n${output}`);
      return;
    }
    return;
  }

  let appliedMigrationId: string | undefined = undefined;

  const dbUrl = process.env.DATABASE_URL?.trim();
  if (dbUrl) {
    const pool = new Pool({
      connectionString: dbUrl,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    try {
      const result = await pool.query<{ id: string }>(`SELECT id FROM fortexa_schema_migrations`);
      const appliedSet = new Set(result.rows.map(r => r.id));
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
