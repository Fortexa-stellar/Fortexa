import { evaluatePolicy, readAmountStroops } from "@/lib/policy/engine";
import { evaluateSecurity } from "@/lib/security/analyzer";
import { checkBlocklist } from "@/lib/security/blocklist";
import {
  parseXlmNumberToStroops,
  parseXlmToStroops,
} from "@/lib/stellar/stroops";
import type {
  AgentAction,
  DailyUsage,
  DecisionResult,
  PolicyConfig,
  PolicyTrigger,
} from "@/lib/types/domain";

/**
 * Payment fields that participate in the allow/deny comparison.
 * Both the live decision route (/api/decision) and the simulation path
 * (/api/policy/simulate via simulatePolicyChange) must evaluate the SAME
 * four fields through this SAME function — that is the parity guarantee
 * for issue #209.
 */
export interface PaymentComparison {
  /** Stellar asset code; only "native" (XLM) is authorized. */
  asset: string;
  /** Payment amount as authorized (string wire form or number). */
  amount: string | number;
  /** Stellar destination address (G...). */
  destination: string;
  /** Optional memo text (max 28 chars on Stellar). */
  memo?: string;
  /** Stellar network id; only "testnet" is authorized. */
  network: string;
}

/** Rule ids emitted by payment-constraint checks (hard blocks). */
export const PAYMENT_HARD_BLOCK_CODES = [
  "MEMO_REQUIRED_MISSING",
  "UNSUPPORTED_ASSET",
  "PAYMENT_AMOUNT_MISMATCH",
  "INVALID_DESTINATION",
  "UNSUPPORTED_NETWORK",
] as const;

function normalizeDestination(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeMemoRequiredList(policy: PolicyConfig): Set<string> {
  const list = policy.memoRequiredDestinations ?? [];
  return new Set(list.map((entry) => normalizeDestination(entry)));
}

function toStroops(amount: string | number): bigint | null {
  const parsed =
    typeof amount === "number"
      ? parseXlmNumberToStroops(amount)
      : parseXlmToStroops(amount);
  if (!parsed.ok) return null;
  if (parsed.stroops <= 0n) return null;
  return parsed.stroops;
}

/**
 * Evaluate asset / amount / destination / memo against policy.
 * Pure function — no transaction building or submission.
 */
export function evaluatePaymentConstraints(
  action: AgentAction,
  payment: PaymentComparison,
  policy: PolicyConfig,
): PolicyTrigger[] {
  const triggers: PolicyTrigger[] = [];

  // Asset: only native XLM is authorized.
  if (payment.asset !== "native") {
    triggers.push({
      code: "UNSUPPORTED_ASSET",
      message: `Asset ${payment.asset} is not authorized; only native XLM is supported.`,
      severity: "high",
    });
  }

  // Destination: must look like a Stellar public key.
  const normalizedDestination = normalizeDestination(payment.destination ?? "");
  if (!/^G[A-Z0-9]{55}$/.test(normalizedDestination)) {
    triggers.push({
      code: "INVALID_DESTINATION",
      message: `Destination ${payment.destination} is not a valid Stellar public key.`,
      severity: "high",
    });
  }

  // Amount: payment amount must exactly match the evaluated action amount.
  // Compared in integer stroops so decimal values do not drift.
  const actionStroops = toStroops(action.amountXLM);
  const paymentStroops = toStroops(payment.amount);
  if (
    actionStroops === null ||
    paymentStroops === null ||
    actionStroops !== paymentStroops
  ) {
    triggers.push({
      code: "PAYMENT_AMOUNT_MISMATCH",
      message: `Payment amount ${String(payment.amount)} does not match action amount ${action.amountXLM} XLM.`,
      severity: "high",
    });
  }

  // Network: only testnet is authorized in current implementation.
  if (payment.network !== "testnet") {
    triggers.push({
      code: "UNSUPPORTED_NETWORK",
      message: `Network ${payment.network} is not authorized; only testnet is supported.`,
      severity: "high",
    });
  }

  // Memo: destinations in memoRequiredDestinations require a non-empty memo.
  const memoRequired = normalizeMemoRequiredList(policy);
  const memoPresent = (payment.memo ?? "").trim().length > 0;
  if (
    normalizedDestination &&
    memoRequired.has(normalizedDestination) &&
    !memoPresent
  ) {
    triggers.push({
      code: "MEMO_REQUIRED_MISSING",
      message: `Destination ${payment.destination} requires a memo, but none was provided.`,
      severity: "high",
    });
  }

  return triggers;
}

/**
 * Machine-readable rule id that fired: first policy trigger code, else first
 * security finding code, else null. Operators compare this — not free-text
 * explanations — across simulate and live decide.
 */
export function getPrimaryRuleId(result: Pick<DecisionResult, "triggeredPolicies" | "riskFindings">): string | null {
  if (result.triggeredPolicies.length > 0) {
    return result.triggeredPolicies[0]!.code;
  }
  if (result.riskFindings.length > 0) {
    return result.riskFindings[0]!.code;
  }
  return null;
}

/**
 * Build a PaymentComparison from a decision-route quote input plus the
 * evaluated action amount. Shared helper so the decision route and any
 * test/fixture constructing the "live" path use identical normalization.
 */
export function buildPaymentComparisonFromQuoteInput(input: {
  destination: string;
  memo?: string;
  network?: string;
  asset?: string;
  amountXLM: number;
}): PaymentComparison {
  return {
    asset: input.asset ?? "native",
    amount: input.amountXLM,
    destination: input.destination,
    memo: input.memo,
    network: input.network ?? "testnet",
  };
}

function decideExplanation(result: DecisionResult): string {
  if (result.decision === "BLOCK") {
    return "Fortexa blocked this action because policy and security controls indicate a materially unsafe payment/tool operation.";
  }

  if (result.decision === "REQUIRE_APPROVAL") {
    return "Fortexa flagged this as high impact. Manual approval is required before economic execution.";
  }

  if (result.decision === "WARN") {
    return "Fortexa allows this action with caution. Risk signals were detected and logged for operator review.";
  }

  return "Fortexa approved this action. Policy checks and risk analysis are within trusted operating bounds.";
}

/** Payment amount stored on an allowing decision, as a stroop integer string. */
export function decisionAmountStroops(amountXLM: number): string | null {
  const stroops = readAmountStroops(amountXLM);
  return stroops === null ? null : stroops.toString();
}

/**
 * Shared evaluation entry point for BOTH /api/decision and
 * /api/policy/simulate. Do not special-case rules in either route — call
 * this function so simulate and live decide always agree.
 */

export async function evaluateDecision(
  action: AgentAction,
  policy: PolicyConfig,
  usage: DailyUsage,
  payment?: PaymentComparison,
): Promise<DecisionResult> {
  const policyResult = evaluatePolicy(action, policy, usage);
  // The analyzer and the blocklist are independent checks: an allow is only
  // possible when both allow the destination. A deny from either blocks.
  const [security, blocklist] = await Promise.all([
    evaluateSecurity(action),
    checkBlocklist(action.domain),
  ]);

  const analyzerDeny = security.findings.find(
    (finding) => finding.severity === "high",
  );
  const denyReasonCode = analyzerDeny?.code ?? blocklist.reasonCode ?? undefined;
  const securityDeny = Boolean(analyzerDeny) || !blocklist.allow;

  const paymentTriggers = payment
    ? evaluatePaymentConstraints(action, payment, policy)
    : [];
  const paymentHardBlock = paymentTriggers.some((t) => t.severity === "high");

  const allTriggers = [...policyResult.triggers, ...paymentTriggers];

  const severeSecurityFinding = security.findings.some(
    (finding) => finding.severity === "high",
  );
  const mediumSecurityFinding = security.findings.some(
    (finding) => finding.severity === "medium",
  );

  let decision: DecisionResult["decision"] = "APPROVE";

  if (policyResult.hardBlock || paymentHardBlock || securityDeny || severeSecurityFinding) {
    decision = "BLOCK";
  } else if (
    policyResult.requireApproval ||
    security.riskScore >= policy.riskThreshold
  ) {
    decision = "REQUIRE_APPROVAL";
  } else if (policyResult.warning || mediumSecurityFinding) {
    decision = "WARN";
  }

  // If analyzer is degraded (timeout or error), escalate decision conservatively:
  // - APPROVE -> WARN (alert operator to degraded state)
  // - WARN -> REQUIRE_APPROVAL (be more protective)
  // - REQUIRE_APPROVAL/BLOCK -> stay same (already conservative)
  if (security.analyzerStatus.isDegraded) {
    if (decision === "APPROVE") {
      decision = "WARN";
    } else if (decision === "WARN") {
      decision = "REQUIRE_APPROVAL";
    }
  }

  const partial = {
    decision,
    explanation: "",
    triggeredPolicies: allTriggers,
    riskScore: security.riskScore,
    riskFindings: security.findings,
    requiresManualApproval: decision === "REQUIRE_APPROVAL",
    analyzerStatus: security.analyzerStatus,
    ...(denyReasonCode ? { reasonCode: denyReasonCode } : {}),
  };

  const primaryRuleId = getPrimaryRuleId(partial);

  const result: DecisionResult = {
    ...partial,
    primaryRuleId,
  };

  result.explanation = decideExplanation(result);

  return result;
}
