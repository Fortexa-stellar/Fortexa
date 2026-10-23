import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { filterPlanAgainstLivePolicy } from "@/lib/ai/plan-filter";
import { PLAN_ERRORS } from "@/lib/ai/plan-errors";
import type { AgentPlanInput } from "@/lib/validation/schemas";

vi.mock("@/lib/storage/policy-store", () => ({
  getPolicyConfig: vi.fn().mockResolvedValue({ policy: "default" }),
}));

vi.mock("@/lib/decision/engine", () => ({
  evaluateDecision: vi.fn(),
}));

vi.mock("@/lib/storage/audit-store", () => ({
  getDailyUsage: vi
    .fn()
    .mockResolvedValue({ spentXLM: 0, toolCalls: 0, lastUpdated: new Date().toISOString() }),
  consumeUsage: vi.fn().mockResolvedValue(undefined),
  appendAuditEntry: vi.fn().mockResolvedValue(undefined),
}));

const { getPolicyConfig } = await import("@/lib/storage/policy-store");
const { consumeUsage, appendAuditEntry } = await import("@/lib/storage/audit-store");
const { evaluateDecision } = await import("@/lib/decision/engine");

const mockedGetPolicyConfig = vi.mocked(getPolicyConfig);
const mockedConsumeUsage = vi.mocked(consumeUsage);
const mockedAppendAuditEntry = vi.mocked(appendAuditEntry);
const mockedEvaluateDecision = vi.mocked(evaluateDecision);

function buildPlanItem(overrides?: Partial<AgentPlanInput["action"]>): AgentPlanInput {
  return {
    id: "plan-item-1",
    action: {
      id: "act-001",
      name: "Research data fetch",
      kind: "api_payment",
      target: "research-pro:fetch-report",
      domain: "api.safe-research.ai",
      amountXLM: 20,
      tool: "research-pro",
      metadata: {},
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetPolicyConfig.mockResolvedValue({
    policy: "default" as never,
    updatedAt: null,
    version: 1,
  });
  mockedEvaluateDecision.mockResolvedValue({
    decision: "APPROVE",
    explanation: "ok",
    triggeredPolicies: [],
    riskScore: 10,
    riskFindings: [],
    requiresManualApproval: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("filterPlanAgainstLivePolicy", () => {
  it("allows every item when the live engine approves it", async () => {
    const outcome = await filterPlanAgainstLivePolicy({
      items: [buildPlanItem(), buildPlanItem({ id: "act-002" })],
      userId: "user-1",
    });

    expect(outcome.allowed).toHaveLength(2);
    expect(outcome.dropped).toHaveLength(0);
    expect(outcome.allowed[0].decisionId).toEqual(expect.any(String));
    expect(mockedAppendAuditEntry).toHaveBeenCalledTimes(2);
  });

  it("drops a denied item and returns the engine denial reason code", async () => {
    mockedEvaluateDecision.mockResolvedValueOnce({
      decision: "BLOCK",
      explanation: "blocked",
      triggeredPolicies: [],
      riskScore: 90,
      riskFindings: [],
      requiresManualApproval: false,
    });

    const outcome = await filterPlanAgainstLivePolicy({
      items: [buildPlanItem()],
      userId: "user-1",
    });

    expect(outcome.allowed).toHaveLength(0);
    expect(outcome.dropped[0].reason).toBe(PLAN_ERRORS.ENGINE_DENIED);
    expect(mockedAppendAuditEntry).not.toHaveBeenCalled();
    expect(mockedConsumeUsage).not.toHaveBeenCalled();
  });

  it("drops an item the engine gates behind manual approval without storing an allow", async () => {
    mockedEvaluateDecision.mockResolvedValueOnce({
      decision: "REQUIRE_APPROVAL",
      explanation: "needs approval",
      triggeredPolicies: [],
      riskScore: 80,
      riskFindings: [],
      requiresManualApproval: true,
    });

    const outcome = await filterPlanAgainstLivePolicy({
      items: [buildPlanItem({ amountXLM: 500 })],
      userId: "user-1",
    });

    expect(outcome.allowed).toHaveLength(0);
    expect(outcome.dropped[0].decision).toBe("REQUIRE_APPROVAL");
    expect(mockedAppendAuditEntry).not.toHaveBeenCalled();
  });

  it("does not consume usage for dropped items", async () => {
    mockedEvaluateDecision.mockResolvedValueOnce({
      decision: "BLOCK",
      explanation: "blocked",
      triggeredPolicies: [],
      riskScore: 90,
      riskFindings: [],
      requiresManualApproval: false,
    });

    await filterPlanAgainstLivePolicy({
      items: [buildPlanItem({ amountXLM: 100 })],
      userId: "user-1",
    });

    expect(mockedConsumeUsage).not.toHaveBeenCalled();
  });

  it("re-reads daily usage before each item so caps see earlier approvals", async () => {
    const { getDailyUsage } = await import("@/lib/storage/audit-store");
    const usageMock = vi.mocked(getDailyUsage);

    usageMock
      .mockResolvedValueOnce({ spentXLM: 0, toolCalls: 0, lastUpdated: new Date().toISOString() })
      .mockResolvedValueOnce({ spentXLM: 50, toolCalls: 1, lastUpdated: new Date().toISOString() });

    await filterPlanAgainstLivePolicy({
      items: [buildPlanItem(), buildPlanItem({ id: "act-002" })],
      userId: "user-1",
    });

    expect(usageMock).toHaveBeenCalledTimes(2);
  });

  it("emits denied logs that never include the raw plan payload", async () => {
    const logSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedEvaluateDecision.mockResolvedValueOnce({
      decision: "BLOCK",
      explanation: "blocked",
      triggeredPolicies: [],
      riskScore: 90,
      riskFindings: [],
      requiresManualApproval: false,
    });

    const secret = "SIGNED_XDR_PAYLOAD_AAAA";
    await filterPlanAgainstLivePolicy({
      items: [buildPlanItem({ target: secret, outputPreview: secret })],
      userId: "user-1",
      logContext: { route: "/api/agent/plan" },
    });

    for (const call of logSpy.mock.calls) {
      expect(String(call[0])).not.toContain(secret);
    }
    logSpy.mockRestore();
  });
});
