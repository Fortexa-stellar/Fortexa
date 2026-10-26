import { readJsonBody } from "@/lib/http/read-json-body";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import {
  buildPaymentComparisonFromQuoteInput,
  decisionAmountStroops,
  evaluateDecision,
} from "@/lib/decision/engine";
import { enforceRequestGate, gateErrorHeaders } from "@/lib/security/enforcement-gate";
import { logValidationFailure } from "@/lib/validation/errors";
import { jsonWithRequestContext } from "@/lib/observability/http";
import {
  getRequestLogContext,
  logError,
  logInfo,
  logWarn,
} from "@/lib/observability/logger";
import { recordDecisionOutcome } from "@/lib/observability/metrics";
import { redactSensitiveFields } from "@/lib/observability/redact";
import { demoScenarios } from "@/lib/scenarios/seed";
import { rateLimitHeaders } from "@/lib/security/rate-limit";
import {
  appendAuditEntry,
  consumeUsage,
  getDailyUsage,
} from "@/lib/storage/audit-store";
import { getUserWallet, isUserWalletRevoked } from "@/lib/storage/user-wallet-store";
import { getPolicyConfig } from "@/lib/storage/policy-store";
import { buildPaymentQuoteFromDecision } from "@/lib/stellar/verify-payment-quote";
import type { AuditEntry } from "@/lib/types/domain";
import { decisionRequestSchema } from "@/lib/validation/schemas";

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/decision");
  let requestBody: unknown;
  const respond: typeof jsonWithRequestContext = (incoming, input) =>
    jsonWithRequestContext(incoming, {
      ...input,
      logExchange: true,
      requestBody,
    });

  // Read the body before consuming the rate budget so the gate can check the
  // requested destination against the blocklist in the same atomic step.
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return respond(request, {
      route: "/api/decision",
      startedAtMs,
      status: bodyResult.status,
      body: { error: bodyResult.error },
    });
  }
  const rawBody = bodyResult.data;

  const rawDestination =
    typeof rawBody === "object" && rawBody !== null
      ? ((rawBody as Record<string, unknown>).destination ??
        ((rawBody as Record<string, unknown>).paymentQuoteInput as Record<string, unknown> | undefined)
          ?.destination ??
        ((rawBody as Record<string, unknown>).paymentQuote as Record<string, unknown> | undefined)
          ?.destination)
      : undefined;

  const rawActionDomain =
    typeof rawBody === "object" && rawBody !== null
      ? ((rawBody as Record<string, unknown>).action as Record<string, unknown> | undefined)
        ?.domain
      : undefined;

  const gate = await enforceRequestGate(request, {
    rateLimitKey: "decision",
    limit: 40,
    windowMs: 60_000,
    destination: typeof rawDestination === "string" ? rawDestination : undefined,
    actionDomain: typeof rawActionDomain === "string" ? rawActionDomain : undefined,
  });

  if (!gate.ok) {
    logWarn("Decision route blocked by enforcement gate", {
      ...context,
      gateCode: gate.code,
    });
    return respond(request, {
      route: "/api/decision",
      startedAtMs,
      status: gate.status,
      body: {
        error: gate.error,
        code: gate.code,
      },
      headers: gateErrorHeaders(gate),
    });
  }

  const rate = gate.rate;

  try {
    const auth = requireAuth(request, { allowedRoles: ["operator", "signer"] });

    if (!auth.ok) {
      logWarn("Decision route unauthorized", context);
      return auth.response;
    }

    const userId = auth.session.userId;

    const isRevoked = typeof isUserWalletRevoked === "function" ? await isUserWalletRevoked(userId) : false;
    if (isRevoked) {
      logWarn("Decision route wallet revoked", { ...context, userId });
      return respond(request, {
        route: "/api/decision",
        startedAtMs,
        status: 401,
        body: { error: "User wallet has been revoked." },
      });
    }

    const userWallet = await getUserWallet(userId);
    if (!userWallet || ("expired" in userWallet && userWallet.expired)) {
      logWarn("Decision route active wallet not found", { ...context, userId });
      return respond(request, {
        route: "/api/decision",
        startedAtMs,
        status: 401,
        body: { error: "No active wallet mapping found for this user." },
      });
    }

    requestBody = rawBody;
    const parsedBody = decisionRequestSchema.safeParse(rawBody);

    if (!parsedBody.success) {
      logValidationFailure("Decision route validation failed", { ...context, userId }, parsedBody.error, rawBody);
      return respond(request, {
        route: "/api/decision",
        startedAtMs,
        status: 400,
        body: {
          error: "Invalid decision request body.",
          details: parsedBody.error.flatten(),
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const body = parsedBody.data;

    const scenarioAction = body.scenarioId
      ? demoScenarios.find((scenario) => scenario.id === body.scenarioId)
          ?.action
      : undefined;

    const action = body.action ?? scenarioAction;

    if (!action) {
      logWarn("Decision route action missing", { ...context, userId });
      return respond(request, {
        route: "/api/decision",
        startedAtMs,
        status: 400,
        body: { error: "No action provided." },
        headers: rateLimitHeaders(rate),
      });
    }

    const { policy } = await getPolicyConfig();
    const usage = await getDailyUsage(userId);

    // Shared engine path (same function simulate uses): include asset,
    // amount, destination, and memo in the allow/deny comparison whenever the
    // caller supplies a payment quote. No transaction is built here.
    const quoteInput = body.paymentQuote ?? body.paymentQuoteInput;
    const payment = quoteInput
      ? buildPaymentComparisonFromQuoteInput({
          destination: quoteInput.destination,
          memo: quoteInput.memo,
          network: quoteInput.network,
          asset: quoteInput.asset,
          amountXLM: action.amountXLM,
        })
      : undefined;
    const decision = await evaluateDecision(action, policy, usage, payment);

    let finalDecision = decision.decision;
    let explanation = decision.explanation;

    if (decision.decision === "REQUIRE_APPROVAL" && body.approvedByHuman) {
      finalDecision = "APPROVE";
      explanation =
        "Manual operator approval granted. Action moved from REQUIRE_APPROVAL to APPROVE.";
    }

    if (finalDecision === "APPROVE" || finalDecision === "WARN") {
      await consumeUsage(userId, action.amountXLM);
    }

    const decisionNowMs = Date.now();
    const auditEntry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date(decisionNowMs).toISOString(),
      action,
      decision: finalDecision,
      explanation,
      triggeredPolicies: decision.triggeredPolicies.map(
        (policy) => `${policy.code}: ${policy.message}`,
      ),
      riskFindings: decision.riskFindings.map(
        (finding) => `${finding.code}: ${finding.detail}`,
      ),
      ...(decision.reasonCode ? { reasonCode: decision.reasonCode } : {}),
      ...((finalDecision === "APPROVE" || finalDecision === "WARN") &&
      (body.paymentQuote || body.paymentQuoteInput)
        ? {
            paymentQuote: (() => {
              const quote = buildPaymentQuoteFromDecision({
                destination: (body.paymentQuote || body.paymentQuoteInput)!.destination,
                amountXLM: action.amountXLM,
                memo: (body.paymentQuote || body.paymentQuoteInput)!.memo,
                actionId: action.id,
                network: (body.paymentQuote || body.paymentQuoteInput)!.network,
              });
              const amountStroops = decisionAmountStroops(action.amountXLM);
              return amountStroops ? { ...quote, amountStroops } : quote;
            })(),
          }
        : {}),
    };

    await appendAuditEntry(userId, auditEntry);

    const latestUsage = await getDailyUsage(userId);

    logInfo("Decision evaluated", {
      ...context,
      userId,
      decision: finalDecision,
      riskScore: decision.riskScore,
    });

    recordDecisionOutcome(finalDecision);

    return respond(request, {
      route: "/api/decision",
      startedAtMs,
      status: 200,
      body: {
        result: {
          ...decision,
          decision: finalDecision,
          explanation,
        },
        auditEntry,
        usage: latestUsage,
        userId,
      },
      headers: rateLimitHeaders(rate),
      // A decision response is per-user and must never be cached.
      noStore: true,
    });
  } catch (error) {
    // #205: pass error detail through the shared observability redactor so
    // destination addresses, memos, and secret-bearing values never reach logs.
    // The API metric for this 500 response is still recorded by
    // jsonWithRequestContext — redaction must not suppress it.
    const redactedDetail =
      error instanceof Error ? redactSensitiveFields(error.message) : "unknown";
    logError("Decision route internal error", {
      ...context,
      detail: redactedDetail,
    });
    return respond(request, {
      route: "/api/decision",
      startedAtMs,
      status: 500,
      body: {
        error:
          error instanceof Error
            ? error.message
            : "Unexpected decision failure.",
      },
      headers: rateLimitHeaders(rate),
    });
  }
}
