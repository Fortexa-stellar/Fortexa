import { NextRequest } from "next/server";

import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logInfo } from "@/lib/observability/logger";
import { evaluateServiceReadiness } from "@/lib/readiness/production";
import { getBlocklistHealth } from "@/lib/security/blocklist";
import { getHorizonServer } from "@/lib/stellar/client";
import { getDatabaseMigrationStatus, runWithDatabase } from "@/lib/storage/db";

export async function GET(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/health");

  logInfo("Health check requested", context);


  const env = {
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    hasAuthSecret: Boolean(process.env.FORTEXA_AUTH_SECRET),
    hasHorizonUrl: Boolean(process.env.STELLAR_HORIZON_URL),
  };

  const migrations = await getDatabaseMigrationStatus();
  const storageCheck = await runWithDatabase("health-check", (pool) => pool.query("SELECT 1"));
  const storageStatus = !migrations.configured
    ? "degraded"
    : migrations.ready
      ? "healthy"
      : "not_ready";

  let horizonStatus = "unknown";
  if (env.hasHorizonUrl) {
    try {
      await getHorizonServer().root();
      horizonStatus = "healthy";
    } catch {
      horizonStatus = "degraded";
    }
  }

  const blocklistData = getBlocklistHealth();
  let blocklistStatus = "unconfigured";
  if (blocklistData.configured) {
    blocklistStatus = blocklistData.lastError ? "degraded" : "healthy";
  }

  const groqStatus = env.hasGroqKey ? "healthy" : "unconfigured";

  const dependencies = {
    storage: storageStatus,
    horizon: horizonStatus,
    blocklist: blocklistStatus,
    groq: groqStatus,
  };
  const ready = storageStatus !== "not_ready";

  const readiness = evaluateServiceReadiness({
    databaseAvailable: storageCheck.available,
    horizonStatus,
  });

  return jsonWithRequestContext(request, {
    route: "/api/health",
    startedAtMs,
    status: ready ? 200 : 503,
    body: {
      ok: ready,
      service: "fortexa",
      timestamp: new Date().toISOString(),
      env,
      migrations,
      blocklist: blocklistData,
      dependencies,
      ready: readiness.ready,
      checks: readiness.checks,
      failingChecks: readiness.failingChecks,
    },
  });
}
