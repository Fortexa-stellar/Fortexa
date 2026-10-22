import { evaluateDecision } from "@/lib/decision/engine";
import { PLAN_ERRORS, type PlanErrorCode } from "@/lib/ai/plan-errors";
import { logInfo, logWarn } from "@/lib/observability/logger";
import { appendAuditEntry, consumeUsage, getDailyUsage } from "@/lib/storage/audit-store";
import { getPolicyConfig } from "@/lib/storage/policy-store";
import type { AgentAction, AuditEntry, DecisionType } from "@/lib/types/domain";
import type { AgentPlanInput } from "@/lib/validation/schemas";

/**
 * Denial reason code surfaced for any plan item the live engine refuses.
 *
 * The plan route is a client of the decision engine, never a second decision
 * maker: whatever the engine denies is dropped here and reported under a
 * single stable reason code, so plan output can never widen what policy
 * allows.
 */
export function denialReasonForDecision(decision: DecisionType): PlanErrorCode {
  if (decision === "APPROVE" || decision === "WARN") {
    throw new Error(`denialReasonForDecision called with executable decision ${decision}.`);
  }

  return PLAN_ERRORS.ENGINE_DENIED;
}

export type PlanFilterItemResult =
  | {
      status: "allowed";
      item: AgentPlanInput;
      decisionId: string;
      decision: DecisionType;
    }
  | {
      status: "dropped";
      item: AgentPlanInput;
      reason: PlanErrorCode;
      decision: DecisionType;
    };

export type PlanFilterOutcome = {
  allowed: Array<PlanFilterItemResult & { status: "allowed" }>;
  dropped: Array<PlanFilterItemResult & { status: "dropped" }>;
  allowedPaymentTotalXLM: number;
};

/**
 * Run every plan item through the live decision engine.
 *
 * For each item the engine's decision is authoritative:
 * - `APPROVE` / `WARN`  → the item is allowed, an audit entry (the engine's
 *   decision id) is stored, and daily usage is consumed for payment kinds.
 * - `BLOCK` / `REQUIRE_APPROVAL` → the item is dropped and a denial reason
 *   code is recorded. Nothing is stored as an allow.
 */
export async function filterPlanAgainstLivePolicy(params: {
  items: AgentPlanInput[];
  userId: string;
  logContext?: Record<string, string | number | boolean | null | undefined>;
}): Promise<PlanFilterOutcome> {
  const { items, userId, logContext } = params;
  const { policy } = await getPolicyConfig();

  const allowed: PlanFilterOutcome["allowed"] = [];
  const dropped: PlanFilterOutcome["dropped"] = [];
  let allowedPaymentTotalXLM = 0;

  for (const item of items) {
    const usage = await getDailyUsage(userId);
    const decision = await evaluateDecision(item.action, policy, usage);

    const executable = decision.decision === "APPROVE" || decision.decision === "WARN";

    if (!executable) {
      dropped.push({
        status: "dropped",
        item,
        reason: denialReasonForDecision(decision.decision),
        decision: decision.decision,
      });

      logWarn("Agent plan item denied by live decision engine", {
        ...logContext,
        planId: item.id,
        decision: decision.decision,
        reason: denialReasonForDecision(decision.decision),
        triggeredPolicies: decision.triggeredPolicies.map((trigger) => trigger.code).join(","),
      });

      continue;
    }

    // The engine authorized this payment: persist its decision as an audit
    // entry (the decision id) and consume budget for payment-like actions.
    const decisionId = await persistEngineDecision({
      userId,
      action: item.action,
      decision,
    });

    if (isPaymentKind(item.action.kind)) {
      allowedPaymentTotalXLM += item.action.amountXLM;
      await consumeUsage(userId, item.action.amountXLM);
    }

    allowed.push({
      status: "allowed",
      item,
      decisionId,
      decision: decision.decision,
    });

    logInfo("Agent plan item allowed by live decision engine", {
      ...logContext,
      planId: item.id,
      decisionId,
      decision: decision.decision,
    });
  }

  return {
    allowed,
    dropped,
    allowedPaymentTotalXLM,
  };
}

function isPaymentKind(kind: AgentAction["kind"]): boolean {
  return kind === "api_payment" || kind === "transfer";
}

async function persistEngineDecision(params: {
  userId: string;
  action: AgentAction;
  decision: Awaited<ReturnType<typeof evaluateDecision>>;
}): Promise<string> {
  const { userId, action, decision } = params;

  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    decision: decision.decision,
    explanation: decision.explanation,
    triggeredPolicies: decision.triggeredPolicies.map(
      (trigger) => `${trigger.code}: ${trigger.message}`
    ),
    riskFindings: decision.riskFindings.map((finding) => `${finding.code}: ${finding.detail}`),
  };

  await appendAuditEntry(userId, entry);

  return entry.id;
}
