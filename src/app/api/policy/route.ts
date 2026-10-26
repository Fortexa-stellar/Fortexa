import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { isLoginAuthorizationPayload } from "@/lib/auth/wallet-challenge";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { readJsonBody } from "@/lib/http/read-json-body";
import { z } from "zod";

import { DuplicateRuleError, validateNoDuplicateRules } from "@/lib/policy/engine";
import { parsePolicyImport, policyImportMatchesActive } from "@/lib/policy/import-export";
import { getPolicyConfig, PolicyVersionConflict, updatePolicyConfig } from "@/lib/storage/policy-store";
import { policyConfigSchema } from "@/lib/validation/schemas";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";
import { hasSensitiveField } from "@/lib/settings/save-safety";
import { getStellarNetworkFingerprint, resolveStellarNetworkConfig } from "@/lib/stellar/network-config";

function isPolicyEqual(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const norm = (val: unknown): unknown => {
    if (Array.isArray(val)) {
      return val.map(norm);
    }
    if (val !== null && typeof val === 'object') {
      const obj = { ...(val as Record<string, unknown>) };
      if (!obj.memoRequiredDestinations) {
        obj.memoRequiredDestinations = [];
      }
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        if (obj[k] !== undefined) {
          sorted[k] = norm(obj[k]);
        }
      }
      return sorted;
    }
    return val;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export async function GET(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/policy");
  const auth = requireAuth(request);

  if (!auth.ok) {
    logWarn("Policy read unauthorized", context);
    return auth.response;
  }

  const rate = await consumeRateLimit(request, {
    key: "policy-get",
    limit: 30,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    logWarn("Policy read rate limited", { ...context, userId: auth.session.userId });
    return jsonWithRequestContext(request, {
      route: "/api/policy",
      startedAtMs,
      status: 429,
      body: { error: "Rate limit exceeded for policy read endpoint." },
      headers: rateLimitHeaders(rate),
    });
  }

  const current = await getPolicyConfig();

  logInfo("Policy read success", { ...context, userId: auth.session.userId });

  return jsonWithRequestContext(request, {
    route: "/api/policy",
    startedAtMs,
    status: 200,
    body: current,
    headers: rateLimitHeaders(rate),
  });
}

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/policy");
  const auth = requireAuth(request, { allowedRoles: ["operator"] });

  if (!auth.ok) {
    logWarn("Policy update unauthorized", context);
    return auth.response;
  }

  const rate = await consumeRateLimit(request, {
    key: "policy-update",
    limit: 20,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    logWarn("Policy update rate limited", { ...context, userId: auth.session.userId });
    return jsonWithRequestContext(request, {
      route: "/api/policy",
      startedAtMs,
      status: 429,
      body: { error: "Rate limit exceeded for policy update endpoint." },
      headers: rateLimitHeaders(rate),
    });
  }

  try {
    const bodyResult = await readJsonBody(request);
    if (bodyResult.ok && isLoginAuthorizationPayload(bodyResult.data)) {
      logWarn("Policy update rejected login payload", {
        ...context,
        userId: auth.session.userId,
        code: "login_payload",
      });
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 400,
        body: { error: "Login signatures cannot authorize a policy write." },
        headers: rateLimitHeaders(rate),
      });
    }

    if (!bodyResult.ok) {
      logWarn("Policy update payload too large", { ...context, userId: auth.session.userId });
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 413,
        body: { error: bodyResult.error },
        headers: rateLimitHeaders(rate),
      });
    }

    if (hasSensitiveField(bodyResult.data)) {
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 400,
        body: { error: "Policy payload contains a sensitive field." },
        headers: rateLimitHeaders(rate),
      });
    }

    if (typeof bodyResult.data === "object" && bodyResult.data !== null &&
        "format" in bodyResult.data) {
      const imported = parsePolicyImport(bodyResult.data);
      if (!imported.ok) {
        return jsonWithRequestContext(request, {
          route: "/api/policy",
          startedAtMs,
          status: 422,
          body: { error: imported.error },
          headers: rateLimitHeaders(rate),
        });
      }

      validateNoDuplicateRules(imported.document.policy);
      const active = await getPolicyConfig();
      const mismatch = policyImportMatchesActive(imported.document, active);
      if (mismatch) {
        return jsonWithRequestContext(request, {
          route: "/api/policy",
          startedAtMs,
          status: imported.document.version !== active.version ? 409 : 422,
          body: { error: mismatch },
          headers: rateLimitHeaders(rate),
        });
      }

      // Importing an unchanged export is a round trip, not a new policy revision.
      if (isPolicyEqual(imported.document.policy, active.policy)) {
        return jsonWithRequestContext(request, {
          route: "/api/policy",
          startedAtMs,
          status: 200,
          body: active,
          headers: rateLimitHeaders(rate),
        });
      }

      const updated = await updatePolicyConfig(imported.document.policy, auth.session.userId, {
        expectedVersion: imported.document.version,
      });
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 200,
        body: updated,
        headers: rateLimitHeaders(rate),
      });
    }

    const expectedNetwork = request.headers.get("x-fortexa-network-fingerprint");
    if (
      !resolveStellarNetworkConfig().ok ||
      (expectedNetwork !== null && expectedNetwork !== getStellarNetworkFingerprint())
    ) {
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 409,
        body: {
          error: "Server network configuration is mismatched; saving is disabled.",
          code: "NETWORK_MISMATCH",
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const parsed = policyConfigSchema.safeParse(bodyResult.data);

    if (!parsed.success) {
      logValidationFailure("Policy update validation failed", { ...context, userId: auth.session.userId }, parsed.error, bodyResult.data);
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 400,
        body: { error: "Invalid policy payload.", details: toPublicValidationDetails(parsed.error) },
        headers: rateLimitHeaders(rate),
      });
    }

    // A client can bypass the editor and POST here directly, so run the same
    // rule-level check the validate route runs. A document the validate route
    // rejects must never activate through this route either.
    try {
      validateNoDuplicateRules(parsed.data);
    } catch (error) {
      if (error instanceof DuplicateRuleError) {
        logWarn("Policy update rejected: duplicate rule identifier", {
          ...context,
          userId: auth.session.userId,
          field: error.field,
          duplicateValue: error.value,
        });
        return jsonWithRequestContext(request, {
          route: "/api/policy",
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
      throw error;
    }

    const versionMeta = z.object({
      expectedVersion: z.number().int().positive().optional(),
    }).safeParse(bodyResult.data);

    if (!versionMeta.success) {
      logValidationFailure("Policy update invalid expectedVersion", { ...context, userId: auth.session.userId }, versionMeta.error, bodyResult.data);
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 400,
        body: { error: "Invalid policy payload.", details: toPublicValidationDetails(versionMeta.error) },
        headers: rateLimitHeaders(rate),
      });
    }

    const { expectedVersion } = versionMeta.data;

    const updated = await updatePolicyConfig(parsed.data, auth.session.userId, {
      expectedVersion,
    });
    logInfo("Policy update success", {
      ...context,
      userId: auth.session.userId,
      version: updated.version,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    return jsonWithRequestContext(request, {
      route: "/api/policy",
      startedAtMs,
      status: 200,
      body: updated,
      headers: rateLimitHeaders(rate),
    });
  } catch (error) {
    if (error instanceof PolicyVersionConflict) {
      logWarn("Policy update version conflict", {
        ...context,
        userId: auth.session.userId,
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
      });
      return jsonWithRequestContext(request, {
        route: "/api/policy",
        startedAtMs,
        status: 409,
        body: {
          error: error.message,
          code: "POLICY_VERSION_CONFLICT",
          expectedVersion: error.expectedVersion,
          currentVersion: error.currentVersion,
          currentUpdatedAt: error.currentUpdatedAt,
        },
        headers: rateLimitHeaders(rate),
      });
    }

    if (error instanceof DuplicateRuleError) {
      logWarn("Policy update rejected: duplicate rule identifier", {
        ...context,
        userId: auth.session.userId,
        field: error.field,
        duplicateValue: error.value,
      });
      return jsonWithRequestContext(request, {
        route: "/api/policy",
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

    logError("Policy update internal error", {
      ...context,
      userId: auth.session.userId,
      detail: error instanceof Error ? error.message : "unknown",
    });
    return jsonWithRequestContext(request, {
      route: "/api/policy",
      startedAtMs,
      status: 500,
      body: { error: error instanceof Error ? error.message : "Failed to update policy." },
      headers: rateLimitHeaders(rate),
    });
  }
}
