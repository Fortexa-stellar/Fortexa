import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  SEVERITY_LEVELS,
  evaluateVulnerabilities,
  loadPolicy,
  runProductionAudit,
} from "./audit-production-deps.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const POLICY_PATH = resolve(REPO_ROOT, "audit-exceptions.json");

describe("Production dependency audit (#343)", () => {
  it("defines a valid audit-exceptions.json policy file with documented threshold and update paths", () => {
    expect(existsSync(POLICY_PATH)).toBe(true);

    const policy = loadPolicy(POLICY_PATH);
    expect(policy.severityThreshold).toBeDefined();
    expect(["high", "critical", "moderate"]).toContain(policy.severityThreshold.toLowerCase());
    expect(SEVERITY_LEVELS[policy.severityThreshold.toLowerCase()]).toBeDefined();
    expect(Array.isArray(policy.exceptions)).toBe(true);

    for (const exception of policy.exceptions) {
      expect(exception.package).toBeTruthy();
      expect(exception.reason).toBeTruthy();
      expect(exception.updatePath).toBeTruthy();
    }
  });

  it("passes when all vulnerabilities are below the blocking severity threshold", () => {
    const mockAuditData = {
      vulnerabilities: {
        "example-low-pkg": {
          name: "example-low-pkg",
          severity: "low",
          via: ["Minor information advisory"],
        },
        "example-moderate-pkg": {
          name: "example-moderate-pkg",
          severity: "moderate",
          via: ["Moderate advisory"],
        },
      },
      metadata: { vulnerabilities: { total: 2 } },
    };

    const policy = {
      severityThreshold: "high",
      exceptions: [],
    };

    const result = evaluateVulnerabilities(mockAuditData, policy);
    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it("blocks and fails when an unexempted high or critical vulnerability is present", () => {
    const mockAuditData = {
      vulnerabilities: {
        "vulnerable-gateway": {
          name: "vulnerable-gateway",
          severity: "high",
          via: [
            {
              title: "Remote code execution gadget",
              url: "https://github.com/advisories/GHSA-test-rce",
            },
          ],
        },
      },
      metadata: { vulnerabilities: { total: 1 } },
    };

    const policy = {
      severityThreshold: "high",
      exceptions: [],
    };

    const result = evaluateVulnerabilities(mockAuditData, policy);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].package).toBe("vulnerable-gateway");
    expect(result.findings[0].severity).toBe("high");
  });

  it("permits documented exceptions with valid reasons and update paths", () => {
    const mockAuditData = {
      vulnerabilities: {
        "known-vulnerable-sdk": {
          name: "known-vulnerable-sdk",
          severity: "high",
          via: ["Known upstream issue"],
        },
      },
      metadata: { vulnerabilities: { total: 1 } },
    };

    const policy = {
      severityThreshold: "high",
      exceptions: [
        {
          package: "known-vulnerable-sdk",
          reason: "Upstream fix scheduled in next major release",
          updatePath: "Upgrade to v2 once released",
        },
      ],
    };

    const result = evaluateVulnerabilities(mockAuditData, policy);
    expect(result.passed).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.exempted).toHaveLength(1);
    expect(result.exempted[0].package).toBe("known-vulnerable-sdk");
    expect(result.exempted[0].updatePath).toBe("Upgrade to v2 once released");
  });

  it("exposes audit:production script in package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts["audit:production"]).toBeDefined();
    expect(pkg.scripts["audit:production"]).toContain("scripts/audit-production-deps.mjs");
  });

  it("includes production dependency audit step in .github/workflows/ci.yml", () => {
    const ciPath = resolve(REPO_ROOT, ".github/workflows/ci.yml");
    expect(existsSync(ciPath)).toBe(true);
    const ci = readFileSync(ciPath, "utf-8");

    expect(ci).toMatch(/run:\s*npm run audit:production/);
  });

  it("executes cleanly on the live repository with zero unexempted blockers", () => {
    const exitCode = runProductionAudit({ configPath: POLICY_PATH });
    expect(exitCode).toBe(0);
  });
});
