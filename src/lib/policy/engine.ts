import { isWithinInterval } from "date-fns";
import { normalizeDomain } from "@/lib/policy/domain";

import type {
  AgentAction,
  DailyUsage,
  PolicyConfig,
  PolicyEvaluation,
  PolicyTrigger,
} from "@/lib/types/domain";
import { amountToStroops } from "@/lib/stellar/stroops";

/** Raised when one policy rule list contains the same identifier twice. */
export class DuplicateRuleError extends Error {
  public readonly field: string;
  public readonly value: string;

  constructor(field: string, value: string) {
    super(
      `Duplicate rule identifier "${value}" found in ${field}. Remove the duplicate before saving or evaluating the policy.`
    );
    this.name = "DuplicateRuleError";
    this.field = field;
    this.value = value;
  }
}

const RULE_LISTS: Array<
  keyof Pick<PolicyConfig, "allowedDomains" | "blockedDomains" | "allowedTools" | "blockedTools">
> = ["allowedDomains", "blockedDomains", "allowedTools", "blockedTools"];

/** Reads a display amount as an exact stroop count, or null when it is not one. */
export function readAmountStroops(value: number | string): bigint | null {
  const parsed = amountToStroops(value);
  return parsed.ok ? parsed.stroops : null;
}

/**
 * Cap used for an allow decision. The stored stroop integer wins when it was
 * written with the policy; otherwise the display amount is converted with the
 * same helper. A value that is not an exact stroop count cannot allow a payment.
 */
export function readCapStroops(displayXlm: number, storedStroops?: string): bigint | null {
  if (storedStroops !== undefined && /^\d+$/.test(storedStroops)) {
    return BigInt(storedStroops);
  }

  return readAmountStroops(displayXlm);
}

/** True when the payment is not an exact stroop amount or is above the per-tx cap. */
export function paymentExceedsPerTxCap(amount: number | string, policy: PolicyConfig): boolean {
  const payment = readAmountStroops(amount);
  const cap = readCapStroops(policy.perTxCapXLM, policy.perTxCapStroops);
  if (payment === null || cap === null) {
    return true;
  }

  return payment > cap;
}

/** Reject repeated identifiers within any single policy rule list. */
export function validateNoDuplicateRules(policy: PolicyConfig): void {
  for (const field of RULE_LISTS) {
    const seen = new Set<string>();
    for (const id of policy[field]) {
      if (seen.has(id)) throw new DuplicateRuleError(field, id);
      seen.add(id);
    }
  }
}

export const defaultPolicyConfig: PolicyConfig = {
  allowedDomains: [
    "api.safe-research.ai",
    "tools.verified-data.dev",
    "workers.fortexa-demo.stellar",
  ],
  blockedDomains: ["wallet-drainer.evil", "prompt-pwn.io", "untrusted-mirror.xyz"],
  allowedTools: ["research-pro", "market-feed", "settlement-worker"],
  blockedTools: ["shadow-shell", "autonomous-payout-bypass"],
  perTxCapXLM: 120,
  dailyCapXLM: 300,
  maxToolCallsPerDay: 8,
  riskThreshold: 78,
  allowedHours: {
    start: 6,
    end: 23,
  },
  // Example custodial/exchange-style destination that requires a memo.
  // Compared case-insensitively after trim + uppercase (see decision engine).
  memoRequiredDestinations: ["GMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM"],
};

export function evaluatePolicy(
  action: AgentAction,
  policy: PolicyConfig,
  usage: DailyUsage
): PolicyEvaluation {
  validateNoDuplicateRules(policy);
  const triggers: PolicyTrigger[] = [];
  const normalizedDomain = normalizeDomain(action.domain);

  if (!normalizedDomain) {
    triggers.push({
      code: "MALFORMED_DOMAIN",
      message: `Domain ${action.domain} is malformed or invalid.`,
      severity: "high",
    });
  } else {
    if (policy.blockedDomains.includes(normalizedDomain)) {
      triggers.push({
        code: "BLOCKED_DOMAIN",
        message: `Domain ${normalizedDomain} is explicitly blocked by policy.`,
        severity: "high",
      });
    }

    if (!policy.allowedDomains.includes(normalizedDomain)) {
      triggers.push({
        code: "UNLISTED_DOMAIN",
        message: `Domain ${normalizedDomain} is not present in allowlist.`,
        severity: "medium",
      });
    }
  }

  if (action.tool && policy.blockedTools.includes(action.tool)) {
    triggers.push({
      code: "BLOCKED_TOOL",
      message: `Tool ${action.tool} is blocked.`,
      severity: "high",
    });
  }

  if (action.tool && !policy.allowedTools.includes(action.tool)) {
    triggers.push({
      code: "UNAPPROVED_TOOL",
      message: `Tool ${action.tool} is not approved.`,
      severity: "medium",
    });
  }

  // Caps and payments are the same stroop integer. Display amounts are converted
  // with the shared helper and are never scaled in floating point.
  const amountStroops = readAmountStroops(action.amountXLM);
  const perTxCapStroops = readCapStroops(policy.perTxCapXLM, policy.perTxCapStroops);
  const dailyCapStroops = readCapStroops(policy.dailyCapXLM, policy.dailyCapStroops);
  const spentStroops = readAmountStroops(usage.spentXLM);

  if (amountStroops === null || perTxCapStroops === null || amountStroops > perTxCapStroops) {
    triggers.push({
      code: "PER_TX_CAP_EXCEEDED",
      message: `Amount ${action.amountXLM} XLM exceeds per transaction cap (${policy.perTxCapXLM} XLM).`,
      severity: "high",
    });
  }

  if (
    amountStroops === null ||
    spentStroops === null ||
    dailyCapStroops === null ||
    spentStroops + amountStroops > dailyCapStroops
  ) {
    triggers.push({
      code: "DAILY_CAP_EXCEEDED",
      message: `Action would exceed daily budget (${policy.dailyCapXLM} XLM).`,
      severity: "high",
    });
  }

  if (usage.toolCalls + 1 > policy.maxToolCallsPerDay) {
    triggers.push({
      code: "TOOL_CALL_LIMIT_REACHED",
      message: `Tool call limit (${policy.maxToolCallsPerDay}) reached for today.`,
      severity: "medium",
    });
  }

  if (policy.allowedHours) {
    const now = new Date();
    const start = new Date(now);
    const end = new Date(now);
    start.setHours(policy.allowedHours.start, 0, 0, 0);
    end.setHours(policy.allowedHours.end, 59, 59, 999);

    if (!isWithinInterval(now, { start, end })) {
      triggers.push({
        code: "OUTSIDE_ALLOWED_TIME",
        message: `Action is outside allowed operation window (${policy.allowedHours.start}:00-${policy.allowedHours.end}:59).`,
        severity: "medium",
      });
    }
  }

  const hardBlock = triggers.some(
    (t) =>
      t.severity === "high" &&
      ["BLOCKED_DOMAIN", "BLOCKED_TOOL", "MALFORMED_DOMAIN"].includes(t.code)
  );
  const requireApproval = triggers.some(
    (t) => t.code === "PER_TX_CAP_EXCEEDED" || t.code === "DAILY_CAP_EXCEEDED"
  );
  const warning = triggers.some((t) => t.severity === "medium");

  return {
    hardBlock,
    requireApproval,
    warning,
    triggers,
  };
}
