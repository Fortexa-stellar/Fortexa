import type {
  AgentAction,
  AnalyzerStatus,
  SecurityEvaluation,
  SecurityFinding,
} from "@/lib/types/domain";
import {
  fetchBlocklist,
  getBlocklistHealth,
} from "@/lib/security/blocklist";

/** Configuration for analyzer timeout behavior. */
export interface AnalyzerConfig {
  blocklistTimeoutMs: number;
}

/** Default analyzer configuration - 5 second timeout for blocklist fetch. */
export const defaultAnalyzerConfig: AnalyzerConfig = {
  blocklistTimeoutMs: 5000,
};

/** Get analyzer config from environment or use defaults. */
export function getAnalyzerConfig(): AnalyzerConfig {
  return {
    blocklistTimeoutMs: parseInt(
      process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS || "5000",
      10,
    ),
  };
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

  if (/private key|secret key|secret seed|mnemonic/i.test(outputPreview)) {
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

type BlocklistFetchStatus = {
  blocked: boolean;
  timedOut: boolean;
  error?: string;
};

/**
 * Fetch the external blocklist with a timeout guard. Never throws: failures
 * are surfaced through the returned status so the analyzer can degrade
 * gracefully instead of failing the whole evaluation. When no blocklist URL is
 * configured the fetch is skipped entirely and an empty list is returned.
 */
async function fetchBlocklistWithTimeout(): Promise<{
  blocklist: string[];
  status: BlocklistFetchStatus;
}> {
  if (!process.env.FORTEXA_BLOCKLIST_URL) {
    return { blocklist: [], status: { blocked: false, timedOut: false } };
  }

  const timeoutMs = getAnalyzerConfig().blocklistTimeoutMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const blocklist = await fetchBlocklist();
    const health = getBlocklistHealth();
    if (health.lastError) {
      return {
        blocklist,
        status: { blocked: true, timedOut: false, error: health.lastError },
      };
    }
    return { blocklist, status: { blocked: false, timedOut: false } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown fetch error";
    const health = getBlocklistHealth();
    const timedOut =
      (err instanceof Error && err.name === "AbortError") ||
      /abort|timeout/i.test(health.lastError ?? message);
    return {
      blocklist: [],
      status: {
        blocked: true,
        timedOut,
        error: health.lastError ?? message,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function evaluateSecurity(
  action: AgentAction,
): Promise<SecurityEvaluation> {
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

  // Fetch blocklist with timeout handling
  const { blocklist, status: blocklistFetchStatus } =
    await fetchBlocklistWithTimeout();

  if (blocklistFetchStatus.timedOut) {
    analyzerStatus.blocklistStatus = "error";
    analyzerStatus.blocklistTimedOut = true;
    analyzerStatus.blocklistError =
      blocklistFetchStatus.error ?? "Blocklist fetch timed out";
    analyzerStatus.isDegraded = true;
    analyzerStatus.degradationReasons?.push("blocklist_timeout");
  } else if (blocklistFetchStatus.blocked) {
    analyzerStatus.blocklistStatus = "error";
    analyzerStatus.blocklistError = blocklistFetchStatus.error;
    analyzerStatus.isDegraded = true;
    analyzerStatus.degradationReasons?.push("blocklist_fetch_failed");
  } else {
    analyzerStatus.blocklistStatus = "success";
  }

  // Add blocklist findings (if available)
  findings.push(...blocklistCheck(action.domain, blocklist));

  const riskScore = Math.min(
    100,
    findings.reduce((acc, finding) => acc + finding.scoreDelta, 10),
  );

  return { riskScore, findings, analyzerStatus };
}
