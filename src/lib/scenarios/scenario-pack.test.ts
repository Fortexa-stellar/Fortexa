import { describe, expect, it, vi } from "vitest";

import { evaluateDecision } from "@/lib/decision/engine";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import {
  evaluateScenarioCatalog,
  validateScenarioPack,
  type ScenarioEvaluation,
  type SeedScenarioInput,
} from "@/lib/scenarios/evaluate";
import { demoScenarios } from "@/lib/scenarios/seed";
import type { DailyUsage, PolicyConfig, Scenario } from "@/lib/types/domain";

const noTimePolicy: PolicyConfig = { ...defaultPolicyConfig, allowedHours: undefined };

const deterministicUsage: DailyUsage = {
  spentXLM: 42,
  toolCalls: 7,
  lastUpdated: "2026-06-29T00:00:00.000Z",
};

const nearLimitUsage: DailyUsage = {
  spentXLM: 42,
  toolCalls: 8,
  lastUpdated: "2026-06-29T00:00:00.000Z",
};

describe("policy pack regression suite", () => {
  it("all scenario ids are unique", () => {
    const ids = demoScenarios.map((s) => s.id);
    expect(new Set(ids).size, "duplicate scenario ids detected").toBe(ids.length);
  });

  it("covers all four decision types", () => {
    const decisions = new Set(demoScenarios.map((s) => s.expectedDecision));
    expect(decisions).toEqual(new Set(["APPROVE", "WARN", "REQUIRE_APPROVAL", "BLOCK"]));
  });

  it("produces deterministic output on repeated evaluation", async () => {
    const scenario = demoScenarios[0]!;
    const first = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
    const second = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
    expect(first.decision).toBe(second.decision);
    expect(first.explanation).toBe(second.explanation);
    expect(first.riskScore).toBe(second.riskScore);
    expect(first.triggeredPolicies).toEqual(second.triggeredPolicies);
  });

  describe("APPROVE scenarios", () => {
    it("safe-research-payment approves allowlisted research payment", async () => {
      const scenario = demoScenarios.find((s) => s.id === "safe-research-payment")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("APPROVE");
      expect(result.requiresManualApproval).toBe(false);
      expect(result.riskFindings.every((f) => f.severity !== "high")).toBe(true);
      expect(result.explanation).toContain("approved");
    });
  });

  describe("WARN scenarios", () => {
    it("typosquat-domain-risk warns for unlisted domain with suspicious TLD", async () => {
      const scenario = demoScenarios.find((s) => s.id === "typosquat-domain-risk")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("WARN");
      expect(result.requiresManualApproval).toBe(false);
      expect(
        result.triggeredPolicies.some((t) => t.code === "UNLISTED_DOMAIN") ||
          result.riskFindings.some((f) => f.code === "SUSPICIOUS_TLD")
      ).toBe(true);
      expect(result.explanation).toContain("allows this action with caution");
    });
  });

  describe("REQUIRE_APPROVAL scenarios", () => {
    it("over-budget-transfer requires approval for cap-exceeding transfer", async () => {
      const scenario = demoScenarios.find((s) => s.id === "over-budget-transfer")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.requiresManualApproval).toBe(true);
      expect(
        result.triggeredPolicies.some(
          (t) => t.code === "PER_TX_CAP_EXCEEDED" || t.code === "DAILY_CAP_EXCEEDED"
        )
      ).toBe(true);
      expect(result.explanation).toContain("Manual approval is required");
    });

    it("manual-approval-needed requires approval for high-value allowlisted payment", async () => {
      const scenario = demoScenarios.find((s) => s.id === "manual-approval-needed")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.requiresManualApproval).toBe(true);
      expect(result.explanation).toContain("Manual approval is required");
    });

    it("daily-cap-breach requires approval when action breaches daily budget", async () => {
      const scenario = demoScenarios.find((s) => s.id === "daily-cap-breach")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.requiresManualApproval).toBe(true);
      expect(result.triggeredPolicies.some((t) => t.code === "DAILY_CAP_EXCEEDED")).toBe(true);
    });

    it("unlisted-domain-risk-threshold warns for unlisted domain with suspicious TLD", async () => {
      const scenario = demoScenarios.find((s) => s.id === "unlisted-domain-risk-threshold")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("WARN");
      expect(result.requiresManualApproval).toBe(false);
      expect(result.riskFindings.some((f) => f.code === "SUSPICIOUS_TLD")).toBe(true);
      expect(result.triggeredPolicies.some((t) => t.code === "UNLISTED_DOMAIN")).toBe(true);
      expect(result.explanation).toContain("allows this action with caution");
    });

    it("per-tx-cap-boundary requires approval at exactly the per-tx cap", async () => {
      const scenario = demoScenarios.find((s) => s.id === "per-tx-cap-boundary")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("REQUIRE_APPROVAL");
      expect(result.requiresManualApproval).toBe(true);
      expect(result.triggeredPolicies.some((t) => t.code === "PER_TX_CAP_EXCEEDED")).toBe(true);
    });

    it("repeated-attempts-rate-limit warns when daily tool-call and risk penalties accumulate", async () => {
      const scenario = demoScenarios.find((s) => s.id === "repeated-attempts-rate-limit")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, nearLimitUsage);
      expect(result.decision).toBe("WARN");
      expect(result.requiresManualApproval).toBe(false);
      expect(result.riskScore).toBeGreaterThan(10);
      expect(result.riskFindings.some((f) => f.code === "SUSPICIOUS_TLD")).toBe(true);
      expect(result.triggeredPolicies.some((t) => t.code === "TOOL_CALL_LIMIT_REACHED")).toBe(true);
      expect(result.explanation).toContain("allows this action with caution");
    });
  });

  describe("BLOCK scenarios", () => {
    it("blocked-malicious-endpoint blocks blacklisted domain", async () => {
      const scenario = demoScenarios.find((s) => s.id === "blocked-malicious-endpoint")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("BLOCK");
      expect(result.requiresManualApproval).toBe(false);
      expect(result.triggeredPolicies.some((t) => t.code === "BLOCKED_DOMAIN")).toBe(true);
      expect(result.explanation).toContain("blocked");
    });

    it("prompt-injection-output blocks prompt-injection payload", async () => {
      const scenario = demoScenarios.find((s) => s.id === "prompt-injection-output")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("BLOCK");
      expect(result.riskFindings.some((f) => f.code === "PROMPT_INJECTION_PATTERN")).toBe(true);
      expect(result.explanation).toContain("blocked");
    });

    it("secret-exfiltration-output blocks requests for wallet secrets", async () => {
      const scenario = demoScenarios.find((s) => s.id === "secret-exfiltration-output")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("BLOCK");
      expect(result.riskFindings.some((f) => f.code === "SECRET_TARGETING")).toBe(true);
      expect(result.explanation).toContain("blocked");
    });

    it("blocked-tool-use blocks invocation of an explicitly blocklisted tool", async () => {
      const scenario = demoScenarios.find((s) => s.id === "blocked-tool-use")!;
      const result = await evaluateDecision(scenario.action, noTimePolicy, deterministicUsage);
      expect(result.decision).toBe("BLOCK");
      expect(result.riskFindings.every((f) => f.severity !== "high")).toBe(true);
      expect(result.triggeredPolicies.some((t) => t.code === "BLOCKED_TOOL")).toBe(true);
      expect(result.explanation).toContain("blocked");
    });
  });

  describe("reviewer-facing descriptions", () => {
    it("every scenario has a non-empty description", () => {
      for (const scenario of demoScenarios) {
        expect(
          scenario.description.trim().length,
          `scenario ${scenario.id} missing description`
        ).toBeGreaterThan(0);
      }
    });
  });
});

describe("scenario pack drift guard", () => {
  const originalBlocklistUrl = process.env.FORTEXA_BLOCKLIST_URL;

  const runWithoutNetwork = async (): Promise<ScenarioEvaluation[]> => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network access is forbidden in the scenario pack suite"));
    try {
      return await evaluateScenarioCatalog();
    } finally {
      fetchSpy.mockRestore();
    }
  };

  it("every seed entry declares an expected decision", () => {
    const issues = validateScenarioPack({ scenarios: demoScenarios });
    const missing = issues.filter((issue) => issue.kind === "missing-expected-decision");
    expect(missing).toEqual([]);
  });

  it("matches every seeded scenario decision against the engine", async () => {
    const evaluations = await runWithoutNetwork();
    expect(evaluations).toHaveLength(demoScenarios.length);

    const issues = validateScenarioPack({ scenarios: demoScenarios, evaluations });
    expect(issues, issues.map((issue) => issue.message).join("\n")).toEqual([]);

    for (const evaluation of evaluations) {
      expect(evaluation.matches, `scenario ${evaluation.scenario.id} drifted`).toBe(true);
    }
  });

  it("fails when a seeded expected decision is mutated away from engine output", async () => {
    const evaluations = await runWithoutNetwork();

    const mutated: Scenario[] = demoScenarios.map((scenario, index) =>
      index === 0
        ? { ...scenario, expectedDecision: "BLOCK" as Scenario["expectedDecision"] }
        : scenario
    );

    const issues = validateScenarioPack({ scenarios: mutated, evaluations });
    const mismatch = issues.find((issue) => issue.kind === "decision-mismatch");

    expect(mismatch).toBeDefined();
    expect(mismatch!.scenarioId).toBe("safe-research-payment");
    expect(mismatch!.message).toContain("seed expects BLOCK");
    expect(mismatch!.message).toContain("engine returned APPROVE");
    expect(mismatch!.message).toContain("src/lib/scenarios/seed.ts");
  });

  it("fails when a seed entry has no expected decision", () => {
    const broken: SeedScenarioInput[] = [{ ...demoScenarios[0]!, expectedDecision: undefined }];

    const issues = validateScenarioPack({ scenarios: broken });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("missing-expected-decision");
    expect(issues[0]!.scenarioId).toBe("safe-research-payment");
  });

  it("evaluates the catalog without contacting Horizon or any network endpoint", async () => {
    delete process.env.FORTEXA_BLOCKLIST_URL;
    try {
      const evaluations = await runWithoutNetwork();
      expect(evaluations).toHaveLength(demoScenarios.length);
    } finally {
      if (originalBlocklistUrl !== undefined) {
        process.env.FORTEXA_BLOCKLIST_URL = originalBlocklistUrl;
      }
    }
  });
});
