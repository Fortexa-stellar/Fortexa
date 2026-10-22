import { DecisionBadge } from "@/components/decision-badge";

export type EngineDecisionResult = {
  decision: "APPROVE" | "WARN" | "REQUIRE_APPROVAL" | "BLOCK";
  explanation: string;
  riskScore: number;
  requiresManualApproval?: boolean;
  /** Reason code of the check that denied the action, when the engine sets one. */
  reasonCode?: string;
  triggeredPolicies: Array<{ code: string; message: string }>;
  riskFindings: Array<{ code: string; detail: string }>;
};

const REDACTED = "[REDACTED]";

// Stellar secret seeds, signed XDR envelopes, bearer tokens and key=value secrets.
const SECRET_PATTERNS: RegExp[] = [
  /\bS[A-Z2-7]{55}\b/g,
  /\bAAAA[A-Za-z0-9+/]{60,}={0,2}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(secret|secret[_ ]?key|private[_ ]?key|seed|mnemonic|token|api[_-]?key|password)\s*[:=]\s*\S+/gi,
];

/** Remove secret material from engine text before it is rendered. */
export function redactVisibleReason(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) =>
      acc.replace(pattern, (match, key?: string) =>
        typeof key === "string" && match.toLowerCase().startsWith(key.toLowerCase())
          ? `${key}=${REDACTED}`
          : REDACTED
      ),
    text
  );
}

/** Rule ids exactly as the engine returned them. */
export function engineRuleIds(result: EngineDecisionResult): string[] {
  return result.triggeredPolicies.map((trigger) => trigger.code);
}

/** Reason codes exactly as the engine returned them, the deny reason first. */
export function engineReasonCodes(result: EngineDecisionResult): string[] {
  const codes = [
    ...(result.reasonCode ? [result.reasonCode] : []),
    ...result.riskFindings.map((finding) => finding.code),
  ];
  return Array.from(new Set(codes));
}

/**
 * A view of the engine decision: decision, rule ids and reason codes are shown
 * unchanged, only secret material in free text is redacted. A missing result
 * renders the empty state, never an allow.
 */
export function DecisionResultView({
  result,
}: {
  result: EngineDecisionResult | null | undefined;
}) {
  if (!result || !result.decision) {
    return (
      <p data-testid="decision-empty" className="text-sm text-[hsl(var(--muted-foreground))]">
        No engine decision yet. Run an evaluation to see the result.
      </p>
    );
  }

  const ruleIds = engineRuleIds(result);
  const reasonCodes = engineReasonCodes(result);

  return (
    <div className="space-y-4 rounded-xl border border-[hsl(var(--border))] p-5">
      <div className="flex items-center justify-between">
        <span data-testid="decision-value" data-decision={result.decision}>
          <DecisionBadge decision={result.decision} />
        </span>
        <div className="relative flex h-16 w-16 items-center justify-center">
          <div className="risk-ring absolute inset-0 rounded-full border-2 border-[hsl(var(--accent)/0.3)]" />
          <span className="text-lg font-semibold">{result.riskScore}</span>
        </div>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-[hsl(var(--muted-foreground))]">Rule id</dt>
        <dd data-testid="decision-rule-ids" className="font-mono text-xs break-all">
          {ruleIds.length > 0 ? ruleIds.join(", ") : "none"}
        </dd>
        <dt className="text-[hsl(var(--muted-foreground))]">Reason code</dt>
        <dd data-testid="decision-reason-codes" className="font-mono text-xs break-all">
          {reasonCodes.length > 0 ? reasonCodes.join(", ") : "none"}
        </dd>
      </dl>
      <p data-testid="decision-explanation" className="text-sm text-[hsl(var(--muted-foreground))]">
        {redactVisibleReason(result.explanation)}
      </p>
      {result.triggeredPolicies.length > 0 || result.riskFindings.length > 0 ? (
        <ul className="space-y-1 text-xs text-[hsl(var(--muted-foreground))]">
          {result.triggeredPolicies.map((trigger, index) => (
            <li key={`policy-${trigger.code}-${index}`}>
              <span className="font-mono">{trigger.code}</span>:{" "}
              {redactVisibleReason(trigger.message)}
            </li>
          ))}
          {result.riskFindings.map((finding, index) => (
            <li key={`finding-${finding.code}-${index}`}>
              <span className="font-mono">{finding.code}</span>:{" "}
              {redactVisibleReason(finding.detail)}
            </li>
          ))}
        </ul>
      ) : null}
      {result.decision === "BLOCK" ? (
        <p className="text-sm text-rose-300">
          Execution blocked. Select a different intent to continue.
        </p>
      ) : null}
    </div>
  );
}
