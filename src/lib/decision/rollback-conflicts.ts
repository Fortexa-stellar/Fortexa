import { evaluatePolicy } from "@/lib/policy/engine";
import { listAllAuditEntriesByUser } from "@/lib/storage/audit-store";
import type { AuditEntry, DailyUsage, PolicyConfig } from "@/lib/types/domain";

export type RollbackConflictReason = "ROLLBACK_WOULD_BLOCK" | "ROLLBACK_WOULD_REQUIRE_APPROVAL";

/**
 * An in-flight payment the candidate policy would no longer allow.
 * Redacted down to ids: no action, destination, memo or amount is included.
 */
export interface RollbackConflict {
  paymentId: string;
  ruleIds: string[];
  reasonCode: RollbackConflictReason;
}

const IN_FLIGHT_USAGE: DailyUsage = {
  spentXLM: 0,
  toolCalls: 0,
  lastUpdated: new Date(0).toISOString(),
};

/** An allow that authorized a payment which has not been submitted yet. */
export function isInFlightAllow(entry: AuditEntry): boolean {
  return (
    (entry.decision === "APPROVE" || entry.decision === "WARN") &&
    Boolean(entry.paymentQuote) &&
    !entry.stellarTxHash
  );
}

/**
 * The single conflict check shared by rollback preview and rollback.
 * Pure and read-only: evaluates each in-flight allow against the candidate
 * policy and lists the ones it would block or send back to approval.
 * Usage is not re-applied because the payment was already counted when allowed.
 */
export function findRollbackConflicts(params: {
  candidatePolicy: PolicyConfig;
  entries: AuditEntry[];
}): RollbackConflict[] {
  const conflicts: RollbackConflict[] = [];

  for (const entry of params.entries) {
    if (!isInFlightAllow(entry)) continue;

    const evaluation = evaluatePolicy(entry.action, params.candidatePolicy, IN_FLIGHT_USAGE);
    if (!evaluation.hardBlock && !evaluation.requireApproval) continue;

    conflicts.push({
      paymentId: entry.id,
      ruleIds: evaluation.triggers.map((trigger) => trigger.code),
      reasonCode: evaluation.hardBlock ? "ROLLBACK_WOULD_BLOCK" : "ROLLBACK_WOULD_REQUIRE_APPROVAL",
    });
  }

  return conflicts.sort((a, b) => a.paymentId.localeCompare(b.paymentId));
}

/** Load every in-flight allow and run the shared conflict check. Never writes. */
export async function collectRollbackConflicts(
  candidatePolicy: PolicyConfig
): Promise<RollbackConflict[]> {
  const byUser = await listAllAuditEntriesByUser();
  return findRollbackConflicts({ candidatePolicy, entries: Object.values(byUser).flat() });
}
