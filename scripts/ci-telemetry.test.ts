import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * Extracts top-level workflow environment variables from a GitHub Actions workflow document.
 */
export function extractWorkflowScopeEnv(workflowContent: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = workflowContent.split(/\r?\n/);
  let inTopLevelEnv = false;

  for (const line of lines) {
    if (/^[a-zA-Z0-9_-]+:/.test(line)) {
      if (line.startsWith("env:")) {
        inTopLevelEnv = true;
        continue;
      } else {
        inTopLevelEnv = false;
      }
    }

    if (inTopLevelEnv) {
      const match = line.match(/^\s+([A-Za-z0-9_]+):\s*["']?([^"'\s#]+)["']?/);
      if (match) {
        env[match[1]] = match[2];
      }
    }
  }

  return env;
}

describe("CI framework telemetry opt-out", () => {
  it("rejects workflow definitions without workflow-scope telemetry opt-out", () => {
    const mockWorkflow = `name: CI\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n`;
    const env = extractWorkflowScopeEnv(mockWorkflow);
    expect(env["NEXT_TELEMETRY_DISABLED"]).toBeUndefined();
  });

  it("extracts workflow-scope environment variables correctly", () => {
    const mockWorkflow = `name: CI\nenv:\n  NEXT_TELEMETRY_DISABLED: "1"\n  OTHER_VAR: "test"\njobs:\n`;
    const env = extractWorkflowScopeEnv(mockWorkflow);
    expect(env["NEXT_TELEMETRY_DISABLED"]).toBe("1");
    expect(env["OTHER_VAR"]).toBe("test");
  });

  it("sets NEXT_TELEMETRY_DISABLED at workflow scope in .github/workflows/ci.yml", () => {
    const workflowPath = resolve(root, ".github/workflows/ci.yml");
    const workflowContent = readFileSync(workflowPath, "utf8");

    const env = extractWorkflowScopeEnv(workflowContent);
    expect(env["NEXT_TELEMETRY_DISABLED"]).toBe("1");
  });

  it("includes an explanation comment noting why telemetry is disabled in CI", () => {
    const workflowPath = resolve(root, ".github/workflows/ci.yml");
    const workflowContent = readFileSync(workflowPath, "utf8");

    expect(workflowContent).toMatch(/#.*telemetry/i);
  });
});
