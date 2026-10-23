import { beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateDecision } from "@/lib/decision/engine";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import { demoScenarios, defaultDailyUsage } from "@/lib/scenarios/seed";

const testPolicy = {
  ...defaultPolicyConfig,
  allowedHours: undefined,
};

function getScenarioAction(id: string) {
  const scenario = demoScenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`Scenario with ID ${id} not found`);
  return scenario.action;
}

function getExpectedDecision(id: string) {
  const scenario = demoScenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`Scenario with ID ${id} not found`);
  return scenario.expectedDecision;
}

describe("Fortexa decision engine - snapshot", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("APPROVE - safe research payment (deterministic)", async () => {
    const action = getScenarioAction("safe-research-payment");
    const result = await evaluateDecision(action, testPolicy, defaultDailyUsage);

    expect(result.decision).toBe(getExpectedDecision("safe-research-payment"));
    expect(result.triggeredPolicies).toEqual([]);
    expect(result.riskFindings).toEqual([]);
    expect(result.riskScore).toBeGreaterThanOrEqual(0);
    expect(result.explanation).toMatchSnapshot();
  });

  it("BLOCK - malicious endpoint (blocked domain)", async () => {
    const action = getScenarioAction("blocked-malicious-endpoint");
    const result = await evaluateDecision(action, testPolicy, defaultDailyUsage);

    expect(result.decision).toBe(getExpectedDecision("blocked-malicious-endpoint"));
    expect(result.triggeredPolicies.some((p) => p.code === "BLOCKED_DOMAIN")).toBe(true);
    expect(result.explanation).toMatchSnapshot();
  });

  it("WARN - typosquat domain risk", async () => {
    const action = getScenarioAction("typosquat-domain-risk");
    const result = await evaluateDecision(action, testPolicy, defaultDailyUsage);

    expect(result.decision).toBe(getExpectedDecision("typosquat-domain-risk"));
    expect(result.triggeredPolicies.some((p) => p.code === "UNLISTED_DOMAIN")).toBe(true);
    expect(result.riskFindings.some((f) => f.code === "SUSPICIOUS_TLD")).toBe(true);
    expect(result.explanation).toMatchSnapshot();
  });

  it("REQUIRE_APPROVAL - over-budget transfer", async () => {
    const action = getScenarioAction("over-budget-transfer");
    const result = await evaluateDecision(action, testPolicy, defaultDailyUsage);

    expect(result.decision).toBe(getExpectedDecision("over-budget-transfer"));
    expect(result.triggeredPolicies.some((p) => p.code === "PER_TX_CAP_EXCEEDED")).toBe(true);
    expect(result.explanation).toMatchSnapshot();
  });
});

// How to update snapshots:
//   npm run test -- src/lib/decision/engine.scenarios.test.ts --updateSnapshot
//   These snapshot tests guard the reviewer-facing explanation text to maintain transparency and prevent drift.
