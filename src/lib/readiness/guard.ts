import type { NextRequest } from "next/server";

import { jsonWithRequestContext } from "@/lib/observability/http";
import { getReadiness } from "@/lib/readiness/checks";
import { readinessBody } from "@/lib/readiness/gate";
import { shouldEnforceProductionReadiness } from "@/lib/readiness/production";

type JsonArgs = Parameters<typeof jsonWithRequestContext>[1];

/**
 * Same readiness gate the health route uses, for routes that cause side
 * effects (decision, pay). Returns a 503 response naming the failing checks
 * when the deployment is not ready, or null when the request may proceed.
 *
 * Enforced in production, matching the existing production readiness
 * behaviour, so local development and demos keep working.
 * Call it BEFORE anything that writes state or moves funds.
 */
export async function readinessBlockResponse(
  request: NextRequest,
  route: string,
  startedAtMs: number,
  headers?: JsonArgs["headers"],
  env: NodeJS.ProcessEnv = process.env
) {
  if (!shouldEnforceProductionReadiness(env)) {
    return null;
  }

  const readiness = await getReadiness(env);
  if (readiness.ready) {
    return null;
  }

  return jsonWithRequestContext(request, {
    route,
    startedAtMs,
    status: 503,
    body: readinessBody(readiness),
    headers,
  });
}
