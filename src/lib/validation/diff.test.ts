import { describe, expect, it } from "vitest";

import { defaultPolicyConfig } from "@/lib/policy/engine";
import { defaultDailyUsage } from "@/lib/scenarios/seed";
import type { AuditEntry, PolicyConfig } from "@/lib/types/domain";
import {
  diffDecisionImpact,
  isAllowDecision,
  openAllowDecisions,
  type OpenAllowDecision,
} from "@/lib/validation/diff";

const activePolicy: PolicyConfig = { ...defaultPolicyConfig };

const allowedPayment: OpenAllowDecision = {
  paymentId: "payment-allow-1",
  decision: "APPROVE",
  usage: defaultDailyUsage,
  action: {
    id: "action-allow-1",
    name: "Allowed research payment",
    kind: "api_payment",
    target: "research-pro:query",
    domain: "api.safe-research.ai",
    amountXLM: 12,
    tool: "research-pro",
  },
};

/** Candidate that blocks the domain of a currently allowed payment. */
const blockingCandidate: PolicyConfig = {
  ...activePolicy,
  allowedDomains: activePolicy.allowedDomains.filter((domain) => domain !== "api.safe-research.ai"),
  blockedDomains: [...activePolicy.blockedDomains, "api.safe-research.ai"],
};

/** Candidate whose only change cannot flip the allowed payment. */
const unrelatedCandidate: PolicyConfig = {
  ...activePolicy,
  perTxCapXLM: 500,
};

function entry(
  overrides: Partial<AuditEntry> & Pick<AuditEntry, "id" | "action" | "decision">
): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    explanation: "seed",
    triggeredPolicies: [],
    riskFindings: [],
    ...overrides,
  };
}

describe("diffDecisionImpact", () => {
  it("lists the payment an allow-flipping rule edit would deny, with the responsible rule id", async () => {
    const report = await diffDecisionImpact({
      activePolicy,
      candidatePolicy: blockingCandidate,
      decisions: [allowedPayment],
    });

    expect(report.status).toBe("decision change");
    expect(report.hasDecisionChange).toBe(true);
    expect(report.flippedIds).toEqual(["payment-allow-1"]);

    const flip = report.flips[0];
    expect(flip.paymentId).toBe("payment-allow-1");
    expect(flip.ruleId).toBe("blockedDomains[api.safe-research.ai]");
    expect(flip.to).toBe("BLOCK");
    expect(isAllowDecision(flip.from)).toBe(true);
  });

  it("attributes a tightened per-transaction cap to its rule id", async () => {
    const report = await diffDecisionImpact({
      activePolicy,
      candidatePolicy: { ...activePolicy, perTxCapXLM: 5 },
      decisions: [allowedPayment],
    });

    expect(report.flippedIds).toEqual(["payment-allow-1"]);
    expect(report.flips[0].ruleId).toBe("perTxCapXLM");
    expect(report.flips[0].to).toBe("REQUIRE_APPROVAL");
  });

  it("reports no decision change when the candidate flips nothing", async () => {
    const report = await diffDecisionImpact({
      activePolicy,
      candidatePolicy: unrelatedCandidate,
      decisions: [allowedPayment],
    });

    expect(report.status).toBe("no decision change");
    expect(report.hasDecisionChange).toBe(false);
    expect(report.flippedIds).toEqual([]);
    expect(report.flips).toEqual([]);
  });

  it("does not report payments the active policy already denies", async () => {
    const alreadyDenied: OpenAllowDecision = {
      ...allowedPayment,
      paymentId: "payment-blocked-1",
      action: {
        ...allowedPayment.action,
        id: "action-blocked-1",
        domain: "wallet-drainer.evil",
      },
    };

    const report = await diffDecisionImpact({
      activePolicy,
      candidatePolicy: blockingCandidate,
      decisions: [alreadyDenied],
    });

    expect(report.status).toBe("no decision change");
    expect(report.flippedIds).toEqual([]);
  });

  it("does not mutate the policies it evaluates", async () => {
    const activeSnapshot = JSON.stringify(activePolicy);
    const candidateSnapshot = JSON.stringify(blockingCandidate);

    await diffDecisionImpact({
      activePolicy,
      candidatePolicy: blockingCandidate,
      decisions: [allowedPayment],
    });

    expect(JSON.stringify(activePolicy)).toBe(activeSnapshot);
    expect(JSON.stringify(blockingCandidate)).toBe(candidateSnapshot);
  });
});

describe("openAllowDecisions", () => {
  it("keeps only the latest open allow per action", () => {
    const entries: AuditEntry[] = [
      entry({
        id: "entry-denied-2",
        action: { ...allowedPayment.action, id: "action-a" },
        decision: "BLOCK",
      }),
      entry({
        id: "entry-allowed-1",
        action: { ...allowedPayment.action, id: "action-a" },
        decision: "APPROVE",
      }),
      entry({
        id: "entry-allowed-3",
        action: { ...allowedPayment.action, id: "action-b" },
        decision: "WARN",
      }),
    ];

    const open = openAllowDecisions(entries, defaultDailyUsage);

    expect(open).toHaveLength(1);
    expect(open[0].paymentId).toBe("entry-allowed-3");
    expect(open[0].decision).toBe("WARN");
    expect(open[0].usage).toEqual(defaultDailyUsage);
  });

  it("returns an empty list when every payment was denied", () => {
    const entries: AuditEntry[] = [
      entry({
        id: "entry-denied",
        action: allowedPayment.action,
        decision: "BLOCK",
      }),
    ];

    expect(openAllowDecisions(entries, defaultDailyUsage)).toEqual([]);
  });
});
