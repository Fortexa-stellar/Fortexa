#!/usr/bin/env node
/**
 * audit-production-deps.mjs
 * =========================
 * Runs a blocking production-only dependency vulnerability audit
 * (`npm audit --omit=dev --json`) with a documented severity threshold
 * (`high` by default, blocking `high` and `critical` advisories) and
 * evaluates findings against `scripts/audit-exceptions.json`.
 *
 * Usage
 * -----
 *   node scripts/audit-production-deps.mjs
 *   node scripts/audit-production-deps.mjs --threshold=critical
 *   npm run audit:prod
 *
 * Exit codes
 * ----------
 *   0  No unexcepted production vulnerabilities at or above the threshold.
 *   1  One or more unexcepted vulnerabilities (or invalid exception entries).
 *   2  Audit execution or configuration error.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXCEPTIONS_PATH = resolve(__dirname, "audit-exceptions.json");

export const SEVERITY_RANK = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

export const DEFAULT_SEVERITY_THRESHOLD = "high";

const GHSA_ID_RE = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

/**
 * Returns true if `severity` is at or above `threshold`.
 *
 * @param {string} severity
 * @param {string} [threshold="high"]
 */
export function severityMeetsThreshold(severity, threshold = DEFAULT_SEVERITY_THRESHOLD) {
  const sevRank = SEVERITY_RANK[String(severity).toLowerCase()];
  const thrRank = SEVERITY_RANK[String(threshold).toLowerCase()];
  if (sevRank === undefined || thrRank === undefined) return false;
  return sevRank >= thrRank;
}

/**
 * Validates the exception configuration file so every exception has a
 * documented GHSA ID, package name, severity, reason, and updatePath.
 *
 * @param {unknown} config
 * @returns {string[]} Validation error messages (empty when valid).
 */
export function validateAuditExceptions(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["Exception configuration must be a JSON object."];
  }

  const threshold = config.severityThreshold ?? DEFAULT_SEVERITY_THRESHOLD;
  if (SEVERITY_RANK[String(threshold).toLowerCase()] === undefined) {
    errors.push(`Invalid severityThreshold "${String(threshold)}".`);
  }

  if (!Array.isArray(config.exceptions)) {
    errors.push('"exceptions" must be an array.');
    return errors;
  }

  config.exceptions.forEach((entry, index) => {
    const label = `exceptions[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    if (typeof entry.ghsaId !== "string" || !GHSA_ID_RE.test(entry.ghsaId)) {
      errors.push(`${label}.ghsaId must be a valid GHSA identifier (GHSA-xxxx-xxxx-xxxx).`);
    }
    if (typeof entry.package !== "string" || entry.package.trim().length === 0) {
      errors.push(`${label}.package must be a non-empty string.`);
    }
    if (
      typeof entry.severity !== "string" ||
      SEVERITY_RANK[entry.severity.toLowerCase()] === undefined
    ) {
      errors.push(`${label}.severity must be a valid npm audit severity.`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
      errors.push(`${label}.reason must document why the advisory is excepted.`);
    }
    if (typeof entry.updatePath !== "string" || entry.updatePath.trim().length === 0) {
      errors.push(`${label}.updatePath must document the remediation/update path.`);
    }
  });

  return errors;
}

function extractGhsaId(advisory) {
  if (typeof advisory?.url === "string") {
    const match = advisory.url.match(/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})/i);
    if (match) return match[1];
  }
  if (typeof advisory?.id === "string" && GHSA_ID_RE.test(advisory.id)) {
    return advisory.id;
  }
  return advisory?.source ? `SOURCE-${String(advisory.source)}` : "UNKNOWN";
}

/**
 * Evaluates an `npm audit --omit=dev --json` report against the configured
 * severity threshold and reviewed exception list.
 *
 * @param {Record<string, unknown>} auditReport
 * @param {{
 *   severityThreshold?: string,
 *   exceptions?: ReadonlyArray<{
 *     ghsaId: string,
 *     package: string,
 *     severity: string,
 *     reason: string,
 *     updatePath: string
 *   }>
 * }} [config]
 */
export function evaluateAuditReport(auditReport, config = {}) {
  const threshold = config.severityThreshold ?? DEFAULT_SEVERITY_THRESHOLD;
  const exceptions = config.exceptions ?? [];
  const validationErrors = validateAuditExceptions({
    severityThreshold: threshold,
    exceptions,
  });

  const blockingFindings = [];
  const exceptedFindings = [];
  const ignoredBelowThreshold = [];

  const vulnerabilities = auditReport?.vulnerabilities;
  if (vulnerabilities && typeof vulnerabilities === "object" && !Array.isArray(vulnerabilities)) {
    for (const [pkgName, vulnEntry] of Object.entries(vulnerabilities)) {
      if (!vulnEntry || typeof vulnEntry !== "object") continue;
      const viaList = Array.isArray(vulnEntry.via) ? vulnEntry.via : [];

      for (const via of viaList) {
        // String entries in `via` are pointers to another package in `vulnerabilities`
        // whose own advisory objects are evaluated directly.
        if (!via || typeof via !== "object") continue;

        const advisoryPkg = typeof via.name === "string" ? via.name : pkgName;
        const severity = String(via.severity ?? vulnEntry.severity ?? "unknown").toLowerCase();
        const ghsaId = extractGhsaId(via);
        const title = typeof via.title === "string" ? via.title : "Vulnerability advisory";
        const url = typeof via.url === "string" ? via.url : "";

        const finding = {
          package: advisoryPkg,
          ghsaId,
          severity,
          title,
          url,
        };

        if (!severityMeetsThreshold(severity, threshold)) {
          ignoredBelowThreshold.push(finding);
          continue;
        }

        const matchedException = exceptions.find(
          (ex) =>
            ex.package === advisoryPkg &&
            ex.ghsaId.toUpperCase() === ghsaId.toUpperCase(),
        );

        if (matchedException) {
          exceptedFindings.push({
            ...finding,
            reason: matchedException.reason,
            updatePath: matchedException.updatePath,
          });
        } else {
          blockingFindings.push(finding);
        }
      }
    }
  }

  return {
    ok: validationErrors.length === 0 && blockingFindings.length === 0,
    threshold,
    validationErrors,
    blockingFindings,
    exceptedFindings,
    ignoredBelowThreshold,
  };
}

/**
 * Runs `npm audit --omit=dev --json` in `root` and evaluates the result.
 *
 * @param {string} root
 * @param {{ exceptionsPath?: string, thresholdOverride?: string }} [options]
 */
export function runProductionAudit(root, options = {}) {
  const exceptionsPath = options.exceptionsPath ?? DEFAULT_EXCEPTIONS_PATH;
  const rawExceptions = JSON.parse(readFileSync(exceptionsPath, "utf8"));
  const config = {
    ...rawExceptions,
    ...(options.thresholdOverride ? { severityThreshold: options.thresholdOverride } : {}),
  };

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const proc = spawnSync(npmCmd, ["audit", "--omit=dev", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (proc.error) {
    throw proc.error;
  }
  const stdout = (proc.stdout ?? "").trim();
  if (!stdout) {
    throw new Error(`npm audit produced no JSON output: ${(proc.stderr ?? "").trim()}`);
  }

  const report = JSON.parse(stdout);
  if (report.error) {
    throw new Error(
      `npm audit error (${report.error.code ?? "UNKNOWN"}): ${report.error.summary ?? ""}`,
    );
  }

  return evaluateAuditReport(report, config);
}

function parseCliArgs(argv) {
  let thresholdOverride;
  let exceptionsPath = DEFAULT_EXCEPTIONS_PATH;
  for (const arg of argv) {
    if (arg.startsWith("--threshold=")) {
      thresholdOverride = arg.slice("--threshold=".length);
    } else if (arg.startsWith("--exceptions=")) {
      exceptionsPath = resolve(arg.slice("--exceptions=".length));
    }
  }
  return { thresholdOverride, exceptionsPath };
}

function main() {
  const { thresholdOverride, exceptionsPath } = parseCliArgs(process.argv.slice(2));
  let result;
  try {
    result = runProductionAudit(process.cwd(), { exceptionsPath, thresholdOverride });
  } catch (error) {
    console.error(
      `audit-production-deps: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  if (result.validationErrors.length > 0) {
    console.error("audit-production-deps: invalid exception configuration:");
    for (const err of result.validationErrors) {
      console.error(`  - ${err}`);
    }
    return 1;
  }

  if (result.blockingFindings.length > 0) {
    console.error(
      `audit-production-deps: ${result.blockingFindings.length} unexcepted production vulnerability(ies) at or above "${result.threshold}":`,
    );
    for (const f of result.blockingFindings) {
      console.error(`  - [${f.severity.toUpperCase()}] ${f.package} (${f.ghsaId}): ${f.title}`);
    }
    console.error(
      "\nTo resolve: upgrade the affected package via `npm update` / `npm audit fix`, or document a reviewed temporary exception with `reason` and `updatePath` in scripts/audit-exceptions.json.",
    );
    return 1;
  }

  console.log(
    `audit-production-deps: passed (threshold=${result.threshold}, trackedExceptions=${result.exceptedFindings.length}).`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
