import { createHash } from "node:crypto";

import type { AuditEntry } from "@/lib/types/domain";

export const GENESIS_HASH = "0".repeat(64);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, canonicalize(obj[key])])
    );
  }
  return value ?? null;
}

/**
 * Deterministic SHA-256 over the entry fields and the previous link.
 * Keys are sorted so the same entry hashes the same way from any store.
 */
export function computeEntryHash(
  entry: Omit<AuditEntry, "entryHash"> & { previousHash: string }
): string {
  const input = {
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.action,
    decision: entry.decision,
    explanation: entry.explanation,
    triggeredPolicies: entry.triggeredPolicies,
    riskFindings: entry.riskFindings,
    stellarTxHash: entry.stellarTxHash ?? null,
    previousHash: entry.previousHash,
  };

  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input)), "utf8")
    .digest("hex");
}

/**
 * Verifies the integrity of a hash chain for a sequence of audit rows.
 * @param rows Array of audit rows to verify
 * @returns true if the hash chain is valid, false otherwise
 */
export function verifyHashChain(rows: Array<{ hash: string; previousHash: string }>): boolean {
  if (rows.length === 0) return true;

  for (let i = 1; i < rows.length; i++) {
    const current = rows[i];
    const previous = rows[i - 1];

    if (current.previousHash !== previous.hash) {
      return false;
    }
  }

  return true;
}

/**
 * Single entry point for verifiers that must agree with each other (the audit
 * export route and the integrity route).
 *
 * The row cap is enforced before verification so an over-cap export is refused
 * without hashing every row, and the returned `boundaries` are the exact ones
 * the chain was verified against so callers can echo them in the response.
 *
 * Throws {@link AuditChainError} with code `audit_chain_row_cap_exceeded` when
 * the row cap is exceeded. A broken chain is reported through `result.valid`
 * rather than thrown, so callers choose how to surface the verifier's reason.
 */
export function verifyAuditChain(
  entries: AuditEntry[],
  options: { boundaries?: ChainBoundaries; maxRows?: number } = {}
): VerifiedChain {
  const maxRows = options.maxRows ?? DEFAULT_MAX_CHAIN_ROWS;
  if (entries.length > maxRows) {
    throw new AuditChainError(
      "audit_chain_row_cap_exceeded",
      `Audit chain exceeds the maximum of ${maxRows} rows.`,
      { maxRows, rowCount: entries.length }
    );
  }

  return -1;
}
