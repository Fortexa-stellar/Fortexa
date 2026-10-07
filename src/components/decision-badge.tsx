import { Badge } from "@/components/ui/badge";
import { decisionVariant } from "@/lib/utils/format";
import type { EngineDecisionResult } from "@/components/decision-result-view";

const ENGINE_CODES = new Set([
  "APPROVE",
  "ALLOW",
  "WARN",
  "REQUIRE_APPROVAL",
  "BLOCK",
  "DENY",
]);

// Stellar secret seeds, signed XDR envelopes, bearer tokens and key=value secrets.
const FORBIDDEN_CONTENT_PATTERNS: RegExp[] = [
  /\bS[A-Z2-7]{55}\b/,
  /\bAAAA[A-Za-z0-9+/]{60,}={0,2}/,
  /\bBearer\s+/i,
  /\b(secret|seed|mnemonic|private[_ ]?key|password)\b/i,
];

export type DecisionBadgeProps = {
  decision?: string | null;
  reasonCode?: string | null;
  result?: Partial<EngineDecisionResult> | Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  className?: string;
};

/**
 * Renders an engine decision badge displaying only valid engine codes.
 * Never renders payment amounts, destinations, memos, signed XDR, or secret material.
 * Empty results render nothing (never an allow badge).
 */
export function DecisionBadge(props: DecisionBadgeProps | { decision: string }) {
  const p = props as DecisionBadgeProps;

  // Extract decision and reason code from result, payload, or direct props
  let decision: string | undefined = undefined;
  let reasonCode: string | undefined = undefined;

  if (p.result && typeof p.result === "object") {
    if (typeof p.result.decision === "string") {
      decision = p.result.decision;
    }
    if (typeof p.result.reasonCode === "string") {
      reasonCode = p.result.reasonCode;
    }
  }

  if (!decision && p.payload && typeof p.payload === "object") {
    const res = p.payload.result as Record<string, unknown> | undefined;
    if (res && typeof res === "object") {
      if (typeof res.decision === "string") decision = res.decision;
      if (typeof res.reasonCode === "string") reasonCode = res.reasonCode;
    } else {
      if (typeof p.payload.decision === "string") decision = p.payload.decision as string;
      if (typeof p.payload.reasonCode === "string") reasonCode = p.payload.reasonCode as string;
    }
  }

  if (!decision && typeof p.decision === "string") {
    decision = p.decision;
  }
  if (!reasonCode && typeof p.reasonCode === "string") {
    reasonCode = p.reasonCode;
  }

  // An empty result shows no allow badge: return null when no decision is present
  if (!decision || typeof decision !== "string" || !decision.trim()) {
    return null;
  }

  const normalized = decision.trim().toUpperCase();

  // Validate that the decision matches an engine code
  const isEngineCode = ENGINE_CODES.has(normalized);
  if (!isEngineCode) {
    return null;
  }

  // Guard against any secret in reasonCode
  let safeReasonCode = reasonCode?.trim();
  if (safeReasonCode) {
    for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
      if (pattern.test(safeReasonCode)) {
        safeReasonCode = undefined;
        break;
      }
    }
  }

  // Map to canonical engine decision code matching route responses
  const displayDecision = normalized === "ALLOW" ? "APPROVE" : normalized === "DENY" ? "BLOCK" : normalized;
  const variant = decisionVariant(displayDecision);

  return (
    <Badge
      variant={variant}
      className={p.className}
      data-testid="decision-badge"
      data-decision={displayDecision}
      data-reason-code={safeReasonCode}
    >
      {displayDecision}
    </Badge>
  );
}
