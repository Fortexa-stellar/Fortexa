import { evaluateDecision, type PaymentComparison } from "@/lib/decision/engine";
import { demoScenarios } from "@/lib/scenarios/seed";
import type {
  AgentAction,
  AuditEntry,
  DailyUsage,
  DecisionResult,
  DecisionType,
  PolicyConfig,
} from "@/lib/types/domain";

/**
 * Maximum number of recent audit entries pulled into a simulation. Kept small
 * and deterministic so a simulation stays cheap and reviewable.
 */
export const DEFAULT_AUDIT_SAMPLE_SIZE = 5;
export const MAX_AUDIT_SAMPLE_SIZE = 10;

export type SimulationSource = "scenario" | "audit";

/** A single action to evaluate against the current and proposed policies. */
export interface SimulationInputCase {
  id: string;
  label: string;
  source: SimulationSource;
  action: AgentAction;
  /**
   * Optional payment comparison (asset, amount, destination, memo, network).
   * When present it is evaluated through the SAME evaluateDecision function
   * the live /api/decision route uses, so simulate and decide cannot drift.
   * When absent, only action/policy/security checks run (backward compatible).
   */
  payment?: PaymentComparison;
}

/** Current-vs-proposed decision comparison for one action. */
export interface SimulationCaseResult extends SimulationInputCase {
  current: DecisionResult;
  proposed: DecisionResult;
  /** True when the proposed policy reaches a different decision than the current one. */
  changed: boolean;
}

export interface SimulationSummary {
  total: number;
  changed: number;
  currentCounts: Record<DecisionType, number>;
  proposedCounts: Record<DecisionType, number>;
}

export interface SimulationReport {
  cases: SimulationCaseResult[];
  summary: SimulationSummary;
}

function emptyDecisionCounts(): Record<DecisionType, number> {
  return { APPROVE: 0, WARN: 0, REQUIRE_APPROVAL: 0, BLOCK: 0 };
}

/** Build simulation cases from the seeded demo scenarios. */
export function scenarioCases(): SimulationInputCase[] {
  return demoScenarios.map((scenario) => ({
    id: `scenario:${scenario.id}`,
    label: scenario.title,
    source: "scenario",
    action: scenario.action,
  }));
}

/**
 * Build simulation cases from a user's audit history. Entries are expected to
 * arrive most-recent-first; the newest `sampleSize` are used so the sample is
 * deterministic.
 *
 * When an audit entry carries a paymentQuote, it is attached as the case
 * payment so the simulation re-evaluates the exact asset/amount/destination/
 * memo the live decision authorized — same engine, same inputs.
 */
export function auditSampleCases(
  entries: AuditEntry[],
  sampleSize: number = DEFAULT_AUDIT_SAMPLE_SIZE
): SimulationInputCase[] {
  const size = Math.max(0, Math.min(sampleSize, MAX_AUDIT_SAMPLE_SIZE));
  return entries.slice(0, size).map((entry) => ({
    id: `audit:${entry.id}`,
    label: entry.action.name,
    source: "audit",
    action: entry.action,
    ...(entry.paymentQuote
      ? {
          payment: {
            asset: entry.paymentQuote.asset,
            amount: entry.paymentQuote.amountXLM,
            destination: entry.paymentQuote.destination,
            memo: entry.paymentQuote.memo,
            network: entry.paymentQuote.network,
          } satisfies PaymentComparison,
        }
      : {}),
  }));
}

/**
 * Evaluate every case against both the current and the proposed policy and
 * report how each decision would change.
 *
 * This is a pure read-only computation: it never persists policy and never
 * consumes usage. Each action is evaluated against the same `usage` snapshot so
 * the result is deterministic regardless of evaluation order.
 *
 * Each case runs through the shared evaluateDecision engine (the same function
 * /api/decision uses), including its optional payment comparison. No
 * transaction is built or submitted here.
 */
export async function simulatePolicyChange(params: {
  currentPolicy: PolicyConfig;
  proposedPolicy: PolicyConfig;
  cases: SimulationInputCase[];
  usage: DailyUsage;
}): Promise<SimulationReport> {
  const { currentPolicy, proposedPolicy, cases, usage } = params;

  const results: SimulationCaseResult[] = [];
  const currentCounts = emptyDecisionCounts();
  const proposedCounts = emptyDecisionCounts();

  for (const input of cases) {
    const current = await evaluateDecision(input.action, currentPolicy, usage, input.payment);
    const proposed = await evaluateDecision(input.action, proposedPolicy, usage, input.payment);

    currentCounts[current.decision] += 1;
    proposedCounts[proposed.decision] += 1;

    results.push({
      ...input,
      current,
      proposed,
      changed: current.decision !== proposed.decision,
    });
  }

  return {
    cases: results,
    summary: {
      total: results.length,
      changed: results.filter((result) => result.changed).length,
      currentCounts,
      proposedCounts,
    },
  };
}

/**
 * Compare the active policy against a historical version to preview rollback impact.
 * Pure read-only: reuses the simulation engine with the rollback target as "proposed".
 */
export async function simulatePolicyRollback(params: {
  currentPolicy: PolicyConfig;
  rollbackPolicy: PolicyConfig;
  cases: SimulationInputCase[];
  usage: DailyUsage;
}): Promise<SimulationReport> {
  return simulatePolicyChange({
    currentPolicy: params.currentPolicy,
    proposedPolicy: params.rollbackPolicy,
    cases: params.cases,
    usage: params.usage,
  });
}
