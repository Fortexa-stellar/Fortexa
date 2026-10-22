import { defaultPolicyConfig } from "@/lib/policy/engine";
import type { AgentAction, DailyUsage, DecisionType, PolicyConfig } from "@/lib/types/domain";
import type { PaymentComparison } from "@/lib/decision/engine";

/**
 * Shared fixture set for issue #209.
 *
 * One fixture set is used by BOTH the live decision engine path
 * (evaluateDecision, as /api/decision calls it) and the simulation path
 * (simulatePolicyChange, as /api/policy/simulate calls it). If either path
 * special-cases a rule, the drift test fails.
 *
 * Every fixture includes the full payment comparison: asset, amount,
 * destination, and memo. Tests never build or submit a transaction — they
 * only evaluate decisions.
 */

export const PARITY_SAFE_DESTINATION = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const PARITY_MEMO_REQUIRED_DESTINATION =
  "GMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";

export const parityPolicy: PolicyConfig = {
  ...defaultPolicyConfig,
  allowedHours: undefined,
  // Deterministic memo-required list for parity checks.
  memoRequiredDestinations: [PARITY_MEMO_REQUIRED_DESTINATION],
};

export const parityUsage: DailyUsage = {
  spentXLM: 42,
  toolCalls: 2,
  lastUpdated: "2026-06-29T00:00:00.000Z",
};

export interface ParityFixture {
  id: string;
  label: string;
  action: AgentAction;
  payment: PaymentComparison;
  expectedDecision: DecisionType;
  /** Expected primary rule id (first policy trigger code, else finding, else null). */
  expectedRuleId: string | null;
}

function baseAction(overrides: Partial<AgentAction>): AgentAction {
  return {
    id: "parity-action",
    name: "Parity fixture payment",
    kind: "api_payment",
    target: "research-pro:query/alpha",
    domain: "api.safe-research.ai",
    amountXLM: 18,
    tool: "research-pro",
    outputPreview: "Top 5 risk-on sectors with confidence score.",
    ...overrides,
  };
}

export const parityFixtures: ParityFixture[] = [
  {
    id: "allow",
    label: "Allowlisted payment with memo",
    action: baseAction({ id: "parity-allow", amountXLM: 18 }),
    payment: {
      asset: "native",
      amount: 18,
      destination: PARITY_SAFE_DESTINATION,
      memo: "fortexa:parity-allow",
      network: "testnet",
    },
    expectedDecision: "APPROVE",
    expectedRuleId: null,
  },
  {
    id: "deny-blocked-domain",
    label: "Blocked domain is denied",
    action: baseAction({
      id: "parity-deny",
      name: "Pay suspicious endpoint",
      kind: "endpoint_call",
      target: "wallet-drainer.evil/paywall",
      domain: "wallet-drainer.evil",
      amountXLM: 12,
    }),
    payment: {
      asset: "native",
      amount: 12,
      destination: PARITY_SAFE_DESTINATION,
      memo: "fortexa:parity-deny",
      network: "testnet",
    },
    expectedDecision: "BLOCK",
    expectedRuleId: "BLOCKED_DOMAIN",
  },
  {
    id: "memo-required-missing",
    label: "Memo-required destination without memo is denied",
    action: baseAction({ id: "parity-memo-missing", amountXLM: 20 }),
    payment: {
      asset: "native",
      amount: 20,
      destination: PARITY_MEMO_REQUIRED_DESTINATION,
      memo: "",
      network: "testnet",
    },
    expectedDecision: "BLOCK",
    expectedRuleId: "MEMO_REQUIRED_MISSING",
  },
  {
    id: "memo-required-present",
    label: "Memo-required destination with memo is allowed",
    action: baseAction({ id: "parity-memo-present", amountXLM: 20 }),
    payment: {
      asset: "native",
      amount: 20,
      destination: PARITY_MEMO_REQUIRED_DESTINATION,
      memo: "exchange-customer-123",
      network: "testnet",
    },
    expectedDecision: "APPROVE",
    expectedRuleId: null,
  },
];
