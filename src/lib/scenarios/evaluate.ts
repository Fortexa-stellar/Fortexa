import { evaluateDecision } from "@/lib/decision/engine";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import { defaultDailyUsage, demoScenarios } from "@/lib/scenarios/seed";
import type { DecisionResult, DecisionType, PolicyConfig, Scenario } from "@/lib/types/domain";

/**
 * A seed entry as it may arrive at runtime. TypeScript guarantees
 * `expectedDecision` on `Scenario`, but seed data can be mutated or generated
 * at runtime, so drift validation must tolerate a missing expectation and
 * report it instead of crashing.
 */
export type SeedScenarioInput = Omit<Scenario, "expectedDecision"> & {
  expectedDecision?: DecisionType | undefined;
};

/** One seeded scenario run through the decision engine. */
export interface ScenarioEvaluation {
  scenario: Scenario;
  /** Expectation declared by the seed. */
  expected: DecisionType;
  /** Decision produced by the engine. */
  actual: DecisionType;
  /** Full engine result (triggers, findings, risk score, analyzer health). */
  result: DecisionResult;
  /** True when the engine decision matches the seed expectation. */
  matches: boolean;
}

export type ScenarioPackIssueKind = "missing-expected-decision" | "decision-mismatch";

export interface ScenarioPackValidationIssue {
  scenarioId: string;
  title: string;
  kind: ScenarioPackIssueKind;
  message: string;
}

/**
 * Policy used to evaluate the catalog: the default policy with the allowed
 * hours window removed so results are deterministic regardless of the wall
 * clock the suite or the page render runs on.
 */
export const scenarioEvaluationPolicy: PolicyConfig = {
  ...defaultPolicyConfig,
  allowedHours: undefined,
};

/** Usage snapshot used for catalog evaluation (matches the seeded demo state). */
export const scenarioEvaluationUsage = defaultDailyUsage;

/**
 * Evaluate a single seeded scenario through the decision engine using the
 * deterministic catalog policy and usage snapshot. Pure computation: it never
 * touches Horizon or any other network dependency.
 */
export async function evaluateScenario(id: string): Promise<ScenarioEvaluation> {
  const scenario = demoScenarios.find((entry) => entry.id === id);
  if (!scenario) {
    throw new Error(`Scenario "${id}" not found in the seed catalog.`);
  }

  const result = await evaluateDecision(
    scenario.action,
    scenarioEvaluationPolicy,
    scenarioEvaluationUsage
  );

  return {
    scenario,
    expected: scenario.expectedDecision,
    actual: result.decision,
    result,
    matches: result.decision === scenario.expectedDecision,
  };
}

/**
 * Run every seeded scenario through the decision engine. The catalog, the
 * seed data, and the engine can change separately - this is the single source
 * of truth for what the engine currently decides, consumed by both the drift
 * tests and the scenarios page.
 */
export async function evaluateScenarioCatalog(): Promise<ScenarioEvaluation[]> {
  const evaluations: ScenarioEvaluation[] = [];
  for (const scenario of demoScenarios) {
    evaluations.push(await evaluateScenario(scenario.id));
  }
  return evaluations;
}

/** Human-readable drift report for one evaluation, including engine rule ids. */
export function formatScenarioDrift(evaluation: ScenarioEvaluation): string {
  const policies =
    evaluation.result.triggeredPolicies.map((trigger) => trigger.code).join(", ") || "none";
  const findings =
    evaluation.result.riskFindings.map((finding) => finding.code).join(", ") || "none";

  return (
    `Scenario "${evaluation.scenario.id}" ("${evaluation.scenario.title}") drift: ` +
    `seed expects ${evaluation.expected} but engine returned ${evaluation.actual} ` +
    `(riskScore ${evaluation.result.riskScore}; policies: ${policies}; findings: ${findings}). ` +
    "Update src/lib/scenarios/seed.ts or fix the decision engine."
  );
}

/**
 * Validate the seed catalog against engine output.
 *
 * Reports an issue when a seed entry has no expected decision at all, and when
 * the engine decision no longer matches the seeded expectation. Without
 * evaluations only the missing-expectation check can run.
 */
export function validateScenarioPack(params: {
  scenarios: ReadonlyArray<SeedScenarioInput>;
  evaluations?: ReadonlyArray<ScenarioEvaluation>;
}): ScenarioPackValidationIssue[] {
  const issues: ScenarioPackValidationIssue[] = [];
  const evaluationById = new Map(
    (params.evaluations ?? []).map((evaluation) => [evaluation.scenario.id, evaluation] as const)
  );

  for (const scenario of params.scenarios) {
    if (!scenario.expectedDecision) {
      issues.push({
        scenarioId: scenario.id,
        title: scenario.title,
        kind: "missing-expected-decision",
        message:
          `Scenario "${scenario.id}" ("${scenario.title}") has no expected decision. ` +
          "Set expectedDecision in src/lib/scenarios/seed.ts.",
      });
      continue;
    }

    const evaluation = evaluationById.get(scenario.id);
    if (!evaluation || evaluation.actual === scenario.expectedDecision) {
      continue;
    }

    issues.push({
      scenarioId: scenario.id,
      title: scenario.title,
      kind: "decision-mismatch",
      message: formatScenarioDrift({
        ...evaluation,
        expected: scenario.expectedDecision,
      }),
    });
  }

  return issues;
}
