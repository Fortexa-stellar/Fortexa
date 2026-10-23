import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  auditDependencyLicenses,
  loadLicensePolicy,
  normalizeLicense,
  runLicenseCheck,
} from "./check-license-allowlist.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const POLICY_PATH = resolve(REPO_ROOT, "license-allowlist.json");

describe("Production dependency license allowlist check (#351)", () => {
  describe("license-allowlist.json configuration", () => {
    it("defines valid allowedLicenses and disallowedLicenses lists", () => {
      expect(existsSync(POLICY_PATH)).toBe(true);

      const policy = loadLicensePolicy(POLICY_PATH);
      expect(Array.isArray(policy.allowedLicenses)).toBe(true);
      expect(Array.isArray(policy.disallowedLicenses)).toBe(true);

      expect(policy.allowedLicenses).toContain("MIT");
      expect(policy.allowedLicenses).toContain("Apache-2.0");
      expect(policy.disallowedLicenses).toContain("GPL-3.0-only");
    });
  });

  describe("normalizeLicense", () => {
    it("normalizes string licenses", () => {
      expect(normalizeLicense("MIT")).toBe("MIT");
      expect(normalizeLicense("  Apache-2.0  ")).toBe("Apache-2.0");
    });

    it("normalizes object licenses", () => {
      expect(normalizeLicense({ type: "ISC" })).toBe("ISC");
    });

    it("falls back to UNKNOWN for missing or empty licenses", () => {
      expect(normalizeLicense(null)).toBe("UNKNOWN");
      expect(normalizeLicense(undefined)).toBe("UNKNOWN");
      expect(normalizeLicense("")).toBe("UNKNOWN");
    });
  });

  describe("auditDependencyLicenses", () => {
    const mockPolicy = {
      allowedLicenses: ["MIT", "Apache-2.0", "ISC"],
      disallowedLicenses: ["GPL-3.0-only", "AGPL-3.0"],
      packageOverrides: {},
    };

    it("passes when all production dependencies are allowed and skips dev dependencies", () => {
      const mockLock = {
        name: "test-app",
        packages: {
          "node_modules/prod-a": { name: "prod-a", license: "MIT", dev: false },
          "node_modules/prod-b": { name: "prod-b", license: "Apache-2.0" },
          "node_modules/dev-only": { name: "dev-only", license: "GPL-3.0-only", dev: true },
        },
      };

      const result = auditDependencyLicenses(mockLock, mockPolicy);
      expect(result.clean).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.packages).toHaveLength(2);
      expect(result.licenseCounts.MIT).toBe(1);
      expect(result.licenseCounts["Apache-2.0"]).toBe(1);
    });

    it("detects and flags explicitly disallowed licenses", () => {
      const mockLock = {
        name: "test-app",
        packages: {
          "node_modules/gpl-lib": { name: "gpl-lib", license: "GPL-3.0-only", dev: false },
        },
      };

      const result = auditDependencyLicenses(mockLock, mockPolicy);
      expect(result.clean).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].reason).toContain("Explicitly disallowed license");
    });

    it("detects and flags missing UNKNOWN licenses", () => {
      const mockLock = {
        name: "test-app",
        packages: {
          "node_modules/unlicensed-lib": { name: "unlicensed-lib", dev: false },
        },
      };

      const result = auditDependencyLicenses(mockLock, mockPolicy);
      expect(result.clean).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].reason).toContain("Missing or unidentifiable license");
    });
  });

  describe("repository integration", () => {
    it("runs cleanly on the live repository with zero license violations", () => {
      const exitCode = runLicenseCheck({ rootDir: REPO_ROOT, configPath: POLICY_PATH });
      expect(exitCode).toBe(0);
    });

    it("declares check:licenses in package.json", () => {
      const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
      expect(pkg.scripts["check:licenses"]).toBe("node scripts/check-license-allowlist.mjs");
    });

    it("includes check:licenses in .github/workflows/ci.yml", () => {
      const ci = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toMatch(/run:\s*npm run check:licenses/);
    });
  });
});
