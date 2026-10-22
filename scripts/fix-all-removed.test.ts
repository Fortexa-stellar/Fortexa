import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("root fix_all.js", () => {
  it("stays deleted and is not invoked by package scripts or CI", () => {
    expect(existsSync(resolve(repoRoot, "fix_all.js"))).toBe(false);

    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };

    const scriptText = Object.values(packageJson.scripts ?? {})
      .filter((command): command is string => typeof command === "string")
      .join("\n");
    expect(scriptText.includes("fix_all")).toBe(false);

    const workflow = readFileSync(
      resolve(repoRoot, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(workflow.includes("fix_all")).toBe(false);
  });
});
