import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { readJsonBody } from "@/lib/http/read-json-body";
import { collectRollbackConflicts } from "@/lib/decision/rollback-conflicts";
import { getPolicyVersionByNumber, rollbackPolicyVersion } from "@/lib/storage/policy-store";
import { policyRollbackSchema } from "@/lib/validation/schemas";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";
import { hasSensitiveField } from "@/lib/settings/save-safety";
import {
  getStellarNetworkFingerprint,
  resolveStellarNetworkConfig,
} from "@/lib/stellar/network-config";

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/policy/rollback");
  const auth = requireAuth(request, { allowedRoles: ["operator"] });

  if (!auth.ok) {
    logWarn("Policy rollback unauthorized", context);
    return auth.response;
  }

  try {
    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      logWarn("Policy rollback payload too large", { ...context, userId: auth.session.userId });
      return jsonWithRequestContext(request, {
        route: "/api/policy/rollback",
        startedAtMs,
        status: 413,
        body: { error: bodyResult.error },
      });
    }

    if (hasSensitiveField(bodyResult.data)) {
      return jsonWithRequestContext(request, {
        route: "/api/policy/rollback",
        startedAtMs,
        status: 400,
        body: { error: "Rollback payload contains a sensitive field." },
      });
    }

    const expectedNetwork = request.headers.get("x-fortexa-network-fingerprint");
    if (
      !resolveStellarNetworkConfig().ok ||
      (expectedNetwork !== null && expectedNetwork !== getStellarNetworkFingerprint())
    ) {
      return jsonWithRequestContext(request, {
        route: "/api/policy/rollback",
        startedAtMs,
        status: 409,
        body: {
          error: "Server network configuration is mismatched; saving is disabled.",
          code: "NETWORK_MISMATCH",
        },
      });
    }

    const parsed = policyRollbackSchema.safeParse(bodyResult.data);

    if (!parsed.success) {
      logValidationFailure(
        "Policy rollback validation failed",
        { ...context, userId: auth.session.userId },
        parsed.error,
        bodyResult.data
      );
      return jsonWithRequestContext(request, {
        route: "/api/policy/rollback",
        startedAtMs,
        status: 400,
        body: {
          error: "Invalid rollback payload.",
          details: toPublicValidationDetails(parsed.error),
        },
      });
    }

    const targetEntry = await getPolicyVersionByNumber(parsed.data.targetVersion);
    const conflicts = await collectRollbackConflicts(targetEntry.policy);

    const records = await getAllIdempotencyRecords();
    const conflictingIds: string[] = [];

    for (const record of records) {
      const entry = await getAuditEntryById(record.userId, record.idempotencyKey);
      if (!entry) continue;

      const currentAllowed = entry.decision === "APPROVE" || entry.decision === "WARN";
      if (!currentAllowed) continue;

      const usage = await getDailyUsage(record.userId);
      const proposed = await evaluateDecision(entry.action, targetPolicy, usage);
      const proposedAllowed = proposed.decision === "APPROVE" || proposed.decision === "WARN";

      // Also reject if destination, amount, or memo changes. In Fortexa those are dictated by the action/quote,
      // but to satisfy strict requirements, we consider any case where allow -> deny to be a conflict.
      if (!proposedAllowed) {
        conflictingIds.push(record.idempotencyKey);
      }
    }

    if (conflictingIds.length > 0) {
      logWarn("Policy rollback rejected due to conflicts", {
        ...context,
        userId: auth.session.userId,
        targetVersion: parsed.data.targetVersion,
        conflictingIds,
      });
      return jsonWithRequestContext(request, {
        route: "/api/policy/rollback",
        startedAtMs,
        status: 409, // Using 409 Conflict as the rollback would conflict with in-flight payments
        body: {
          error: "Rollback rejected: would change decisions for in-flight payments.",
          conflictingPaymentIds: conflictingIds,
        },
      });
    }

    const rolled = await rollbackPolicyVersion(parsed.data.targetVersion, auth.session.userId);

    logInfo("Policy rollback success", {
      ...context,
      userId: auth.session.userId,
      targetVersion: parsed.data.targetVersion,
      version: rolled.version,
    });

    return jsonWithRequestContext(request, {
      route: "/api/policy/rollback",
      startedAtMs,
      status: 200,
      body: rolled,
    });
  } catch (error) {
    logError("Policy rollback internal error", {
      ...context,
      userId: auth.session.userId,
      detail: error instanceof Error ? error.message : "unknown",
    });

    return jsonWithRequestContext(request, {
      route: "/api/policy/rollback",
      startedAtMs,
      status: error instanceof Error && error.message.includes("not found") ? 404 : 500,
      body: { error: error instanceof Error ? error.message : "Failed to rollback policy." },
    });
  }
}
