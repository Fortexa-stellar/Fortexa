#!/usr/bin/env node
/**
 * audit-production-deps.mjs
 * =========================
 * Production-only dependency vulnerability auditor for Fortexa CI.
 *
 * Enforces a blocking audit on production dependencies with a configurable
 * severity threshold (defaults to 'high') and an exceptions registry with
 * documented justifications and update paths.
 *
 * Usage:
 *   node scripts/audit-production-deps.mjs
 *   npm run audit:production
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

export const SEVERITY_LEVELS = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(__dirname, "../audit-exceptions.json");

/**
 * Loads the audit policy and exceptions registry from file.
 * @param {string} configPath
 * @returns {{ severityThreshold: string, exceptions: Array }}
 */
export function loadPolicy(configPath = DEFAULT_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    return { severityThreshold: "high", exceptions: [] };
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse audit policy from ${configPath}:`, err.message);
    process.exit(2);
  }
}

/**
 * Analyzes parsed npm audit output against the given policy.
 * @param {object} auditData
 * @param {object} policy
 * @returns {{ passed: boolean, findings: Array, exempted: Array, stats: object }}
 */
export function evaluateVulnerabilities(auditData, policy) {
  const thresholdName = (policy.severityThreshold || "high").toLowerCase();
  const thresholdRank = SEVERITY_LEVELS[thresholdName] ?? SEVERITY_LEVELS.high;
  const exceptions = policy.exceptions || [];

  const vulnerabilities = auditData.vulnerabilities || {};
  const findings = [];
  const exempted = [];

  for (const [pkgName, vuln] of Object.entries(vulnerabilities)) {
    const vulnSeverity = (vuln.severity || "info").toLowerCase();
    const vulnRank = SEVERITY_LEVELS[vulnSeverity] ?? 0;

    // Check if severity meets or exceeds blocking threshold
    if (vulnRank >= thresholdRank) {
      // Check if exempted by package name or advisory ID
      const matchingException = exceptions.find((ex) => {
        if (ex.package && ex.package === pkgName) return true;
        if (ex.advisory && Array.isArray(vuln.via)) {
          return vuln.via.some(
            (v) => typeof v === "object" && v.url && v.url.includes(ex.advisory)
          );
        }
        return false;
      });

      if (matchingException) {
        exempted.push({
          package: pkgName,
          severity: vulnSeverity,
          reason: matchingException.reason,
          updatePath: matchingException.updatePath || "Unspecified",
        });
      } else {
        findings.push({
          package: pkgName,
          severity: vulnSeverity,
          title: Array.isArray(vuln.via)
            ? vuln.via
                .map((v) => (typeof v === "object" ? v.title : v))
                .filter(Boolean)
                .join("; ")
            : "Unknown vulnerability",
          fixAvailable: vuln.fixAvailable || null,
        });
      }
    }
  }

  return {
    passed: findings.length === 0,
    findings,
    exempted,
    stats: auditData.metadata?.vulnerabilities || {},
  };
}

/**
 * Runs the production audit scan and outputs report.
 */
export function runProductionAudit(options = {}) {
  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const policy = options.policy || loadPolicy(configPath);
  const threshold = policy.severityThreshold || "high";

  console.log(`[audit:production] Running production dependency audit (blocking threshold: ${threshold.toUpperCase()}+)...`);

  let stdout = "";
  try {
    stdout = execSync("npm audit --json --omit=dev", {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    stdout = err.stdout ? err.stdout.toString() : "";
  }

  let auditData;
  try {
    auditData = JSON.parse(stdout || "{}");
  } catch (err) {
    console.error("[audit:production] Failed to parse npm audit output:", err.message);
    return 2;
  }

  const evaluation = evaluateVulnerabilities(auditData, policy);

  console.log(`[audit:production] Policy threshold: >= ${threshold.toUpperCase()}`);
  console.log(`[audit:production] Total production vulnerabilities reported: ${evaluation.stats.total ?? 0}`);
  console.log(`[audit:production] Documented exceptions: ${evaluation.exempted.length}`);

  if (evaluation.exempted.length > 0) {
    console.log("\nDocumented exceptions allowed:");
    for (const ex of evaluation.exempted) {
      console.log(`  - ${ex.package} (${ex.severity.toUpperCase()}): ${ex.reason}`);
      console.log(`    Update path: ${ex.updatePath}`);
    }
  }

  if (!evaluation.passed) {
    console.error("\n❌ [FAIL] Unexempted vulnerabilities detected at or above blocking threshold:");
    for (const f of evaluation.findings) {
      console.error(`  - ${f.package} [${f.severity.toUpperCase()}]: ${f.title}`);
      if (f.fixAvailable) {
        console.error(`    Fix available: ${JSON.stringify(f.fixAvailable)}`);
      }
    }
    console.error("\nResolution required:");
    console.error("1. Update the vulnerable dependency: `npm update <package>` or `npm audit fix`");
    console.error("2. If upgrade is blocked by upstream breaking changes, document an exception in audit-exceptions.json with a justification and update path.\n");
    return 1;
  }

  console.log("\n✅ [PASS] No unexempted production vulnerabilities at or above threshold.");
  return 0;
}

// Direct execution entrypoint
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exitCode = runProductionAudit();
  process.exit(exitCode);
}
