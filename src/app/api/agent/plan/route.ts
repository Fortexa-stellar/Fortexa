import { NextRequest, NextResponse } from "next/server";

import { generateAgentActionWithGroq } from "@/lib/ai/groq";
import { filterPlanAgainstLivePolicy } from "@/lib/ai/plan-filter";
import { PlanError, PLAN_ERRORS, PLAN_ERROR_MESSAGES } from "@/lib/ai/plan-errors";
import { requireAuth } from "@/lib/auth/require-auth";
import { logError, logWarn } from "@/lib/observability/logger";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { agentPlanRequestSchema } from "@/lib/validation/schemas";
import { toPublicValidationDetails } from "@/lib/validation/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = requireAuth(request, { allowedRoles: ["operator"] });

  if (!auth.ok) {
    return auth.response;
  }

  const rate = await consumeRateLimit(request, {
    key: "agent-plan",
    limit: 20,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded for agent planning. Try again shortly." },
      { status: 429, headers: rateLimitHeaders(rate) }
    );
  }

  const logContext: Record<string, string | number | boolean | null | undefined> = {
    route: "/api/agent/plan",
  };

  try {
    const rawBody = (await request.json().catch(() => ({}))) as unknown;
    const parsed = agentPlanRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
      // Intentionally do not log the raw request body here: it may embed
      // secrets or signed XDR from upstream automation, and the zod details
      // are enough to diagnose the failure.
      logWarn("Agent plan validation failed", logContext);

      return NextResponse.json(
        {
          error: "Invalid request body.",
          details: toPublicValidationDetails(parsed.error),
        },
        { status: 400, headers: rateLimitHeaders(rate) }
      );
    }

    const plan = await generateAgentActionWithGroq(parsed.data);

    // The planner is not a decision maker: run the schema-valid plan through
    // the live decision engine before anything is returned or stored.
    const outcome = await filterPlanAgainstLivePolicy({
      items: [plan],
      userId: auth.session.userId,
      logContext,
    });

    if (outcome.allowed.length === 0) {
      const reason = outcome.dropped[0]?.reason ?? PLAN_ERRORS.ENGINE_DENIED;
      const message = PLAN_ERROR_MESSAGES[reason];

      logWarn("Agent plan denied", { ...logContext, code: reason });

      return NextResponse.json(
        {
          ok: false,
          error: message,
          code: reason,
        },
        { status: 422, headers: rateLimitHeaders(rate) }
      );
    }

    const decisionId = outcome.allowed[0].decisionId;
    const decision = outcome.allowed[0].decision;

    return NextResponse.json(
      {
        ok: true,
        action: plan.action,
        decisionId,
        decision,
        provider: "groq",
      },
      { headers: rateLimitHeaders(rate) }
    );
  } catch (error) {
    if (error instanceof PlanError) {
      logWarn("Agent plan generation failed", {
        code: error.code,
        detail: error.message,
        route: "/api/agent/plan",
      });

      return NextResponse.json(
        {
          error: PLAN_ERROR_MESSAGES[error.code],
          code: error.code,
        },
        { status: 422, headers: rateLimitHeaders(rate) }
      );
    }

    logError("Unexpected error in agent plan route", {
      detail: error instanceof Error ? error.message : "unknown",
      route: "/api/agent/plan",
    });

    return NextResponse.json(
      { error: "Failed to generate agent plan." },
      { status: 500, headers: rateLimitHeaders(rate) }
    );
  }
}
