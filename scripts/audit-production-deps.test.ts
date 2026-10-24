import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEVERITY_THRESHOLD,
  evaluateAuditReport,
  runProductionAudit,
  severityMeetsThreshold,
  validateAuditExceptions,
} from "./audit-production-deps.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const EXCEPTIONS_PATH = resolve(__dirname, "audit-exceptions.json");

describe("severityMeetsThreshold", () => {
  it("enforces the default high threshold (blocking high and critical only)", () => {
    expect(DEFAULT_SEVERITY_THRESHOLD).toBe("high");
    expect(severityMeetsThreshold("info")).toBe(false);
    expect(severityMeetsThreshold("low")).toBe(false);
    expect(severityMeetsThreshold("moderate")).toBe(false);
    expect(severityMeetsThreshold("high")).toBe(true);
    expect(severityMeetsThreshold("critical")).toBe(true);
  });

  it("supports custom threshold overrides", () => {
    expect(severityMeetsThreshold("moderate", "moderate")).toBe(true);
    expect(severityMeetsThreshold("high", "critical")).toBe(false);
    expect(severityMeetsThreshold("critical", "critical")).toBe(true);
  });
});

describe("validateAuditExceptions", () => {
  it("accepts a well-formed exception with ghsaId, package, severity, reason, and updatePath", () => {
    const errors = validateAuditExceptions({
      severityThreshold: "high",
      exceptions: [
        {
          ghsaId: "GHSA-c29m-xwm3-cm6r",
          package: "axios",
          severity: "high",
          reason: "Transitive dependency not exposed to untrusted data URIs.",
          updatePath: "Run `npm update axios` once upstream releases fix.",
        },
      ],
    });
    expect(errors).toEqual([]);
  });

  it("rejects exception entries missing reason, updatePath, or valid GHSA ID", () => {
    const errors = validateAuditExceptions({
      severityThreshold: "high",
      exceptions: [
        {
          ghsaId: "INVALID-ID",
          package: "",
          severity: "high",
          reason: "",
          updatePath: "",
        },
      ],
    });
    expect(errors).toEqual([
      "exceptions[0].ghsaId must be a valid GHSA identifier (GHSA-xxxx-xxxx-xxxx).",
      "exceptions[0].package must be a non-empty string.",
      "exceptions[0].reason must document why the advisory is excepted.",
      "exceptions[0].updatePath must document the remediation/update path.",
    ]);
  });
});

describe("evaluateAuditReport", () => {
  const sampleReport = {
    auditReportVersion: 2,
    vulnerabilities: {
      "@stellar/stellar-sdk": {
        name: "@stellar/stellar-sdk",
        severity: "high",
        via: ["axios"],
      },
      axios: {
        name: "axios",
        severity: "high",
        via: [
          {
            source: 1,
            name: "axios",
            title: "Axios high severity issue",
            url: "https://github.com/advisories/GHSA-c29m-xwm3-cm6r",
            severity: "high",
          },
          {
            source: 2,
            name: "axios",
            title: "Axios moderate issue",
            url: "https://github.com/advisories/GHSA-vh66-26gq-q6x8",
            severity: "moderate",
          },
        ],
      },
    },
  };

  it("blocks when an unexcepted high or critical advisory is present", () => {
    const result = evaluateAuditReport(sampleReport, {
      severityThreshold: "high",
      exceptions: [],
    });
    expect(result.ok).toBe(false);
    expect(result.blockingFindings).toEqual([
      {
        package: "axios",
        ghsaId: "GHSA-c29m-xwm3-cm6r",
        severity: "high",
        title: "Axios high severity issue",
        url: "https://github.com/advisories/GHSA-c29m-xwm3-cm6r",
      },
    ]);
    expect(result.ignoredBelowThreshold).toHaveLength(1);
  });

  it("passes when high/critical advisories are covered by documented exceptions", () => {
    const result = evaluateAuditReport(sampleReport, {
      severityThreshold: "high",
      exceptions: [
        {
          ghsaId: "GHSA-c29m-xwm3-cm6r",
          package: "axios",
          severity: "high",
          reason: "Reviewed transitive risk.",
          updatePath: "Upgrade @stellar/stellar-sdk and remove exception.",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.blockingFindings).toEqual([]);
    expect(result.exceptedFindings).toHaveLength(1);
    expect(result.exceptedFindings[0]?.updatePath).toContain(
      "Upgrade @stellar/stellar-sdk",
    );
  });
});

describe("repository production dependency audit (#343)", () => {
  it("ships a valid scripts/audit-exceptions.json with documented threshold and update paths", () => {
    const config = JSON.parse(readFileSync(EXCEPTIONS_PATH, "utf8"));
    expect(validateAuditExceptions(config)).toEqual([]);
    expect(config.severityThreshold).toBe("high");
  });

  it("exposes npm run audit:prod in package.json and passes against current production dependencies", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["audit:prod"]).toBe("node scripts/audit-production-deps.mjs");

    const result = runProductionAudit(REPO_ROOT);
    expect(result.validationErrors).toEqual([]);
    expect(result.blockingFindings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
