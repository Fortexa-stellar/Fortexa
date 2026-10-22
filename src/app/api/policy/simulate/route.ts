import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import {
  DEFAULT_AUDIT_SAMPLE_SIZE,
  auditSampleCases,
  scenarioCases,
  simulatePolicyChange,
} from "@/lib/decision/simulate";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { readJsonBody } from "@/lib/http/read-json-body";
import { getDailyUsage, listAuditEntries } from "@/lib/storage/audit-store";
import { DuplicateRuleError } from "@/lib/policy/engine";
import { getPolicyConfig } from "@/lib/storage/policy-store";
import { policySimulateRequestSchema } from "@/lib/validation/schemas";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/policy/simulate");
  const auth = requireAuth(request, { allowedRoles: ["operator"] });

  if (!auth.ok) {
    logWarn("Policy simulate unauthorized", context);
    return auth.response;
  }

  const rate = await consumeRateLimit(request, {
    key: "policy-simulate",
    limit: 20,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    logWarn("Policy simulate rate limited", { ...context, userId: auth.session.userId });
    return jsonWithRequestContext(request, {
      route: "/api/policy/simulate",
      startedAtMs,
      status: 429,
      body: { error: "Rate limit exceeded for policy simulate endpoint." },
      headers: rateLimitHeaders(rate),
    });
  }

  try {
    const userId = auth.session.userId;

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      logWarn("Policy simulate payload too large", { ...context, userId });
      return jsonWithRequestContext(request, {
        route: "/api/policy/simulate",
        startedAtMs,
        status: 413,
        body: { error: bodyResult.error },
        headers: rateLimitHeaders(rate),
      });
    }

    const parsed = policySimulateRequestSchema.safeParse(bodyResult.data);

    if (!parsed.success) {
      logValidationFailure(
        "Policy simulate validation failed",
        { ...context, userId },
        parsed.error,
        bodyResult.data
      );
      return jsonWithRequestContext(request, {
        route: "/api/policy/simulate",
        startedAtMs,
        status: 400,
        body: {
          error: "Invalid simulation payload.",
          details: toPublicValidationDetails(parsed.error),
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const { policy: proposedPolicy, includeAudit, auditSampleSize } = parsed.data;

    // Read-only snapshots. Nothing below mutates policy or usage state.
    const { policy: currentPolicy } = await getPolicyConfig();
    const usage = await getDailyUsage(userId);

    const cases = scenarioCases();
    let auditSampled = 0;

    if (includeAudit) {
      const entries = await listAuditEntries(userId);
      const auditCases = auditSampleCases(entries, auditSampleSize ?? DEFAULT_AUDIT_SAMPLE_SIZE);
      auditSampled = auditCases.length;
      cases.push(...auditCases);
    }

    const report = await simulatePolicyChange({
      currentPolicy,
      proposedPolicy,
      cases,
      usage,
    });

    logInfo("Policy simulation evaluated", {
      ...context,
      userId,
      total: report.summary.total,
      changed: report.summary.changed,
      auditSampled,
    });

    return jsonWithRequestContext(request, {
      route: "/api/policy/simulate",
      startedAtMs,
      status: 200,
      body: {
        report,
        auditSampled,
        usage,
        userId,
      },
      headers: rateLimitHeaders(rate),
    });
  } catch (error) {
    if (error instanceof DuplicateRuleError) {
      logWarn("Policy simulate rejected: duplicate rule identifier", {
        ...context,
        userId: auth.session.userId,
        field: error.field,
        duplicateValue: error.value,
      });
      return jsonWithRequestContext(request, {
        route: "/api/policy/simulate",
        startedAtMs,
        status: 422,
        body: {
          error: error.message,
          code: "DUPLICATE_RULE_IDENTIFIER",
          field: error.field,
          duplicateValue: error.value,
        },
        headers: rateLimitHeaders(rate),
      });
    }

    logError("Policy simulate internal error", {
      ...context,
      userId: auth.session.userId,
      detail: error instanceof Error ? error.message : "unknown",
    });
    return jsonWithRequestContext(request, {
      route: "/api/policy/simulate",
      startedAtMs,
      status: 500,
      body: { error: error instanceof Error ? error.message : "Failed to simulate policy." },
      headers: rateLimitHeaders(rate),
    });
  }
}
