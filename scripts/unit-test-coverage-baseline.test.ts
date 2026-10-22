import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface CoverageConfig {
  provider?: string;
  reporter?: string[];
  thresholds?: {
    statements?: number;
    branches?: number;
    functions?: number;
    lines?: number;
  };
}

export function validateCoverageBaseline(coverage?: CoverageConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!coverage) {
    return { valid: false, errors: ["Missing coverage configuration"] };
  }

  if (!coverage.provider || !["v8", "istanbul"].includes(coverage.provider)) {
    errors.push("Coverage provider must be 'v8' or 'istanbul'");
  }

  if (!Array.isArray(coverage.reporter) || !coverage.reporter.includes("text")) {
    errors.push("Coverage reporters must include 'text' for summary reporting");
  }

  const statements = coverage.thresholds?.statements;
  const branches = coverage.thresholds?.branches;

  if (typeof statements !== "number" || statements <= 0) {
    errors.push("A positive statements coverage threshold must be enforced");
  }

  if (typeof branches !== "number" || branches <= 0) {
    errors.push("A positive branches coverage threshold must be enforced");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

describe("Unit test coverage baseline", () => {
  it("rejects configuration missing required thresholds", () => {
    const invalid = validateCoverageBaseline({
      provider: "v8",
      reporter: ["text"],
      thresholds: {},
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toContain("A positive statements coverage threshold must be enforced");
    expect(invalid.errors).toContain("A positive branches coverage threshold must be enforced");
  });

  it("rejects configuration missing the text summary reporter", () => {
    const invalid = validateCoverageBaseline({
      provider: "v8",
      reporter: ["json"],
      thresholds: { statements: 50, branches: 50 },
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toContain("Coverage reporters must include 'text' for summary reporting");
  });

  it("verifies vitest.config.ts enforces the documented modest coverage baseline", async () => {
    const vitestConfigFile = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
    expect(vitestConfigFile).toContain('provider: "v8"');
    expect(vitestConfigFile).toContain('"text"');
    expect(vitestConfigFile).toContain('"json-summary"');
    expect(vitestConfigFile).toMatch(/statements:\s*\d+/);
    expect(vitestConfigFile).toMatch(/branches:\s*\d+/);

    const configModule = await import("../vitest.config");
    const testConfig = (configModule.default as { test?: { coverage?: CoverageConfig } })?.test?.coverage;

    const validation = validateCoverageBaseline(testConfig);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    // Verify baseline values
    expect(testConfig?.thresholds?.statements).toBeGreaterThanOrEqual(50);
    expect(testConfig?.thresholds?.branches).toBeGreaterThanOrEqual(50);
  });

  it("declares test:coverage script in package.json", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(packageJson.scripts?.["test:coverage"]).toBe("vitest run --coverage");
    expect(packageJson.devDependencies?.["@vitest/coverage-v8"]).toBeDefined();
  });

  it("documents test:coverage and baseline thresholds in README.md", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    expect(readme).toContain("npm run test:coverage");
    expect(readme).toContain("statements and branches");
  });
});
