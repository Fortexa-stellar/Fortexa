import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const CHANGELOG_PATH = resolve(REPO_ROOT, "CHANGELOG.md");
const README_PATH = resolve(REPO_ROOT, "README.md");

export const REQUIRED_SECURITY_PILLARS = [
  "Auth",
  "Policy",
  "Audit",
  "Payment",
] as const;

export interface ChangelogValidationResult {
  valid: boolean;
  missingSections: string[];
}

/**
 * Validates that a security changelog defines the format section, Unreleased
 * section, a versioned baseline release section, and all four security pillars.
 */
export function validateSecurityChangelog(
  content: string,
): ChangelogValidationResult {
  const missingSections: string[] = [];

  if (!/^#\s+Security Changelog/m.test(content)) {
    missingSections.push("# Security Changelog");
  }
  if (!/^##\s+Format/m.test(content)) {
    missingSections.push("## Format");
  }
  if (!/^##\s+\[Unreleased\]/m.test(content)) {
    missingSections.push("## [Unreleased]");
  }

  const baselineIndex = content.search(/^##\s+\[\d+\.\d+\.\d+\]/m);
  if (baselineIndex === -1) {
    missingSections.push("## [x.y.z] baseline release");
  } else {
    const baselineSlice = content.slice(baselineIndex);
    for (const pillar of REQUIRED_SECURITY_PILLARS) {
      const headingRe = new RegExp(`^###\\s+${pillar}\\b`, "m");
      if (!headingRe.test(baselineSlice)) {
        missingSections.push(`### ${pillar} (baseline)`);
      }
    }
  }

  return {
    valid: missingSections.length === 0,
    missingSections,
  };
}

describe("security changelog (#362)", () => {
  it("ships CHANGELOG.md at the repository root", () => {
    expect(
      existsSync(CHANGELOG_PATH),
      "CHANGELOG.md missing at repository root",
    ).toBe(true);
  });

  it("validates format, unreleased, and baseline sections for Auth, Policy, Audit, and Payment", () => {
    const content = readFileSync(CHANGELOG_PATH, "utf8");
    const result = validateSecurityChangelog(content);
    expect(result).toEqual({
      valid: true,
      missingSections: [],
    });
  });

  it("rejects changelog content that omits required security pillars", () => {
    const incomplete = [
      "# Security Changelog",
      "## Format",
      "## [Unreleased]",
      "## [1.0.0] - 2026-06-29",
      "### Auth",
      "- **[Added]** Wallet login.",
      "### Policy",
      "- **[Added]** Policy engine.",
    ].join("\n");

    const result = validateSecurityChangelog(incomplete);
    expect(result.valid).toBe(false);
    expect(result.missingSections).toEqual([
      "### Audit (baseline)",
      "### Payment (baseline)",
    ]);
  });

  it("documents concrete baseline controls and valid repository file links", () => {
    const content = readFileSync(CHANGELOG_PATH, "utf8");

    expect(content).toContain("src/lib/auth/wallet-challenge.ts");
    expect(content).toContain("src/lib/policy/engine.ts");
    expect(content).toContain("src/lib/audit/hash-chain.ts");
    expect(content).toContain("src/lib/stellar/verify-payment-quote.ts");
    expect(content).toContain("src/lib/security/enforcement-gate.ts");

    const linkMatches = [...content.matchAll(/\[[^\]]+\]\(([^)#]+)\)/g)];
    expect(linkMatches.length).toBeGreaterThan(0);

    for (const match of linkMatches) {
      const target = match[1]!;
      if (/^[a-z]+:/i.test(target)) continue;
      const resolved = resolve(REPO_ROOT, target);
      expect(
        existsSync(resolved),
        `broken link in CHANGELOG.md: ${target}`,
      ).toBe(true);
    }
  });

  it("documents the security changelog in README.md", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toMatch(/\[`?CHANGELOG\.md`?\]\(\.?\/?CHANGELOG\.md\)/);
  });
});
