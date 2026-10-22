import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import {
  DEFAULT_AUDIT_SAMPLE_SIZE,
  auditSampleCases,
  scenarioCases,
  simulatePolicyRollback,
} from "@/lib/decision/simulate";
import { collectRollbackConflicts } from "@/lib/decision/rollback-conflicts";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { getDailyUsage, listAuditEntries } from "@/lib/storage/audit-store";
import { getPolicyConfig, getPolicyVersionByNumber } from "@/lib/storage/policy-store";
import { policyRollbackPreviewSchema } from "@/lib/validation/schemas";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/policy/rollback/preview");
  const auth = requireAuth(request, { allowedRoles: ["operator"] });

  if (!auth.ok) {
    logWarn("Policy rollback preview unauthorized", context);
    return auth.response;
  }

  const rate = await consumeRateLimit(request, {
    key: "policy-rollback-preview",
    limit: 20,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    logWarn("Policy rollback preview rate limited", { ...context, userId: auth.session.userId });
    return jsonWithRequestContext(request, {
      route: "/api/policy/rollback/preview",
      startedAtMs,
      status: 429,
      body: { error: "Rate limit exceeded for policy rollback preview endpoint." },
      headers: rateLimitHeaders(rate),
    });
  }

  try {
    const userId = auth.session.userId;
    const rawBody = (await request.json().catch(() => ({}))) as unknown;
    const parsed = policyRollbackPreviewSchema.safeParse(rawBody);

    if (!parsed.success) {
      logValidationFailure(
        "Policy rollback preview validation failed",
        { ...context, userId },
        parsed.error,
        rawBody
      );
      return jsonWithRequestContext(request, {
        route: "/api/policy/rollback/preview",
        startedAtMs,
        status: 400,
        body: {
          error: "Invalid rollback preview payload.",
          details: toPublicValidationDetails(parsed.error),
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const { targetVersion, includeAudit, auditSampleSize } = parsed.data;
    const { policy: currentPolicy, version: currentVersion } = await getPolicyConfig();
    const targetEntry = await getPolicyVersionByNumber(targetVersion);

    const usage = await getDailyUsage(userId);
    const cases = scenarioCases();
    let auditSampled = 0;

    if (includeAudit) {
      const entries = await listAuditEntries(userId);
      const auditCases = auditSampleCases(entries, auditSampleSize ?? DEFAULT_AUDIT_SAMPLE_SIZE);
      auditSampled = auditCases.length;
      cases.push(...auditCases);
    }

    const report = await simulatePolicyRollback({
      currentPolicy,
      rollbackPolicy: targetEntry.policy,
      cases,
      usage,
    });

    const conflicts = await collectRollbackConflicts(targetEntry.policy);

    logInfo("Policy rollback preview evaluated", {
      ...context,
      userId,
      targetVersion,
      currentVersion,
      changed: report.summary.changed,
      auditSampled,
      conflicts: conflicts.length,
    });

    return jsonWithRequestContext(request, {
      route: "/api/policy/rollback/preview",
      startedAtMs,
      status: 200,
      body: {
        report,
        targetVersion,
        currentVersion,
        auditSampled,
        conflicts,
      },
      headers: rateLimitHeaders(rate),
    });
  } catch (error) {
    logError("Policy rollback preview internal error", {
      ...context,
      userId: auth.session.userId,
      detail: error instanceof Error ? error.message : "unknown",
    });

    return jsonWithRequestContext(request, {
      route: "/api/policy/rollback/preview",
      startedAtMs,
      status: error instanceof Error && error.message.includes("not found") ? 404 : 500,
      body: {
        error: error instanceof Error ? error.message : "Failed to preview policy rollback.",
      },
      headers: rateLimitHeaders(rate),
    });
  }
}
