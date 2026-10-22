import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CHANGELOG_PATH = resolve(REPO_ROOT, "SECURITY_CHANGELOG.md");
const README_PATH = resolve(REPO_ROOT, "README.md");

describe("Security-relevant behavior changelog (#362)", () => {
  it("exists at SECURITY_CHANGELOG.md in the repository root", () => {
    expect(existsSync(CHANGELOG_PATH)).toBe(true);
  });

  it("contains contributor guidelines for formatting future security changes", () => {
    const content = readFileSync(CHANGELOG_PATH, "utf-8");
    expect(content.toLowerCase()).toContain("guidelines");
    expect(content).toContain("[SECURITY ADDED]");
    expect(content).toContain("[SECURITY CHANGED]");
    expect(content).toContain("[SECURITY FIXED]");
  });

  it("documents the security baseline across all 4 mandatory domains", () => {
    const content = readFileSync(CHANGELOG_PATH, "utf-8");

    // Domain 1: Auth
    expect(content).toMatch(/###\s*Auth/i);
    expect(content).toMatch(/wallet-bound|challenge|SEP-53/i);
    expect(content).toMatch(/lockout|rate limit/i);
    expect(content).toMatch(/session/i);

    // Domain 2: Policy
    expect(content).toMatch(/###\s*Policy/i);
    expect(content).toMatch(/policy engine/i);
    expect(content).toMatch(/rollback/i);
    expect(content).toMatch(/schema|zod/i);

    // Domain 3: Audit
    expect(content).toMatch(/###\s*Audit/i);
    expect(content).toMatch(/hash chain|sha-256/i);
    expect(content).toMatch(/integrity/i);
    expect(content).toMatch(/redact/i);

    // Domain 4: Payment
    expect(content).toMatch(/###\s*Payment/i);
    expect(content).toMatch(/quote/i);
    expect(content).toMatch(/private key/i);
    expect(content).toMatch(/blocklist/i);
    expect(content).toMatch(/idempotent|idempotency/i);
  });

  it("is referenced in the main README.md", () => {
    expect(existsSync(README_PATH)).toBe(true);
    const readme = readFileSync(README_PATH, "utf-8");
    expect(readme).toContain("SECURITY_CHANGELOG.md");
  });
});
