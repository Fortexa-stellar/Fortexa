import type {
  AgentAction,
  AnalyzerStatus,
  SecurityEvaluation,
  SecurityFinding,
} from "@/lib/types/domain";
import {
  BlocklistUrlError,
  DEFAULT_BLOCKLIST_TIMEOUT_MS,
  fetchBlocklist,
  getBlocklistTimeoutMs,
  getStaleBlocklist,
  isBlocklistTimeout,
} from "@/lib/security/blocklist";

/** Configuration for analyzer timeout behavior. */
export interface AnalyzerConfig {
  blocklistTimeoutMs: number;
}

/** Default analyzer configuration - 5 second timeout for blocklist fetch. */
export const defaultAnalyzerConfig: AnalyzerConfig = {
  blocklistTimeoutMs: DEFAULT_BLOCKLIST_TIMEOUT_MS,
};

/**
 * The analyzer configuration in effect: the blocklist timeout comes from
 * `FORTEXA_BLOCKLIST_TIMEOUT_MS` (bounded, see `getBlocklistTimeoutMs`).
 */
export function getAnalyzerConfig(): AnalyzerConfig {
  return { blocklistTimeoutMs: getBlocklistTimeoutMs() };
}

const suspiciousPatterns = [
  /ignore\s+all\s+previous\s+instructions/i,
  /send\s+funds\s+to/i,
  /bypass\s+policy/i,
  /reveal\s+secret/i,
  /exfiltrate/i,
  /execute\s+shell/i,
];

const highRiskTlds = [".zip", ".click", ".top", ".ru"];

function reputationCheck(domain: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  if (
    domain.includes("evil") ||
    domain.includes("drainer") ||
    domain.includes("phish")
  ) {
    findings.push({
      code: "DOMAIN_REPUTATION_HIGH_RISK",
      title: "High-risk destination",
      detail: `Domain ${domain} matches high-risk reputation patterns.`,
      severity: "high",
      scoreDelta: 45,
    });
  }

  if (highRiskTlds.some((tld) => domain.endsWith(tld))) {
    findings.push({
      code: "SUSPICIOUS_TLD",
      title: "Suspicious top-level domain",
      detail: `Domain ${domain} ends with a high-risk TLD.`,
      severity: "medium",
      scoreDelta: 16,
    });
  }

  if (domain.includes("redirect") || domain.includes("mirror")) {
    findings.push({
      code: "POTENTIAL_REDIRECT_TRAP",
      title: "Possible redirect mismatch",
      detail:
        "Endpoint naming suggests potential redirect/man-in-the-middle behavior.",
      severity: "medium",
      scoreDelta: 12,
    });
  }

  return findings;
}

function outputSafetyCheck(outputPreview?: string): SecurityFinding[] {
  if (!outputPreview) {
    return [];
  }

  const findings: SecurityFinding[] = [];
  for (const pattern of suspiciousPatterns) {
    if (pattern.test(outputPreview)) {
      findings.push({
        code: "PROMPT_INJECTION_PATTERN",
        title: "Prompt injection signature detected",
        detail: `Detected suspicious instruction pattern: ${pattern.source}`,
        severity: "high",
        scoreDelta: 35,
      });
      break;
    }
  }

  if (/private key|secret seed|mnemonic/i.test(outputPreview)) {
    findings.push({
      code: "SECRET_TARGETING",
      title: "Sensitive secret extraction attempt",
      detail: "Tool output appears to request wallet secrets or seed phrases.",
      severity: "high",
      scoreDelta: 40,
    });
  }

  return findings;
}

function targetCheck(action: AgentAction): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  if (action.amountXLM > 90) {
    findings.push({
      code: "LARGE_PAYMENT",
      title: "High-value transfer",
      detail: `Action amount (${action.amountXLM} XLM) is above heuristic caution threshold.`,
      severity: "medium",
      scoreDelta: 14,
    });
  }

  if (action.target.includes("anon") || action.target.includes("temp")) {
    findings.push({
      code: "UNVERIFIED_TARGET",
      title: "Unverified payment target",
      detail: "Destination appears ephemeral or weakly identified.",
      severity: "medium",
      scoreDelta: 10,
    });
  }

  return findings;
}

function blocklistCheck(
  domain: string,
  blocklist: string[],
): SecurityFinding[] {
  if (blocklist.includes(domain)) {
    return [
      {
        code: "BLOCKLIST_MATCH",
        title: "Domain on external blocklist",
        detail: `Domain ${domain} is present in the configured threat-intel blocklist.`,
        severity: "high",
        scoreDelta: 50,
      },
    ];
  }
  return [];
}

type BlocklistLoad = {
  blocklist: string[];
  /** Set when the feed could not be refreshed; `null` when it was reachable (or not configured). */
  failure: { timedOut: boolean; error: string } | null;
};

/**
 * Load the blocklist, never waiting longer than the blocklist timeout and never
 * throwing.
 *
 * `fetchBlocklist` aborts a slow feed itself and rethrows every failure. The
 * fallback is deterministic: the last list fetched successfully, or an empty
 * list if there never was one, together with a failure the caller reports as a
 * degraded check. A stale list can only add findings, so falling back to it never
 * hides a known-bad domain.
 */
async function loadBlocklist(): Promise<BlocklistLoad> {
  try {
    return { blocklist: await fetchBlocklist(), failure: null };
  } catch (err) {
    // A misconfigured production URL is a deployment error, not a feed failure.
    if (err instanceof BlocklistUrlError) throw err;
    return {
      blocklist: getStaleBlocklist(),
      failure: {
        timedOut: isBlocklistTimeout(err),
        error: err instanceof Error ? err.message : "Blocklist fetch failed",
      },
    };
  }
}

export async function evaluateSecurity(
  action: AgentAction,
): Promise<SecurityEvaluation> {
  const config = getAnalyzerConfig();
  const analyzerStatus: AnalyzerStatus = {
    blocklistStatus: "success",
    isDegraded: false,
    degradationReasons: [],
  };

  // Run local checks (always succeed)
  const findings = [
    ...reputationCheck(action.domain),
    ...outputSafetyCheck(action.outputPreview),
    ...targetCheck(action),
  ];

  // Fetch the blocklist; a failure degrades the evaluation but never aborts it.
  const { blocklist, failure } = await loadBlocklist();

  if (failure) {
    analyzerStatus.blocklistStatus = "error";
    analyzerStatus.blocklistError = failure.error;
    analyzerStatus.isDegraded = true;
    if (failure.timedOut) {
      analyzerStatus.blocklistTimedOut = true;
      analyzerStatus.degradationReasons?.push(
        `blocklist_timeout_${config.blocklistTimeoutMs}ms`,
      );
    } else {
      analyzerStatus.degradationReasons?.push("blocklist_fetch_failed");
    }
  }

  // Add blocklist findings (the fresh list, or the stale one after a failure)
  findings.push(...blocklistCheck(action.domain, blocklist));

  const riskScore = Math.min(
    100,
    findings.reduce((acc, finding) => acc + finding.scoreDelta, 10),
  );

  return { riskScore, findings, analyzerStatus };
}
