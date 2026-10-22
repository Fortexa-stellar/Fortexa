import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** npm script names invoked as `npm run <name>` in a workflow document. */
export function npmScriptsReferencedByWorkflow(workflow: string): string[] {
  const scripts = new Set<string>();
  for (const match of workflow.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
    scripts.add(match[1]);
  }
  return [...scripts];
}

export function missingNpmScripts(
  workflow: string,
  packageJson: { scripts?: Record<string, string> },
): string[] {
  const known = new Set(Object.keys(packageJson.scripts ?? {}));
  return npmScriptsReferencedByWorkflow(workflow).filter((name) => !known.has(name));
}

describe("CI npm script manifest", () => {
  it("fails when a workflow npm script is missing from package.json", () => {
    const missing = missingNpmScripts("run: npm run does-not-exist\n", {
      scripts: { lint: "eslint ." },
    });
    expect(missing).toEqual(["does-not-exist"]);
  });

  it("accepts every npm script referenced by the CI workflow", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(missingNpmScripts(workflow, packageJson)).toEqual([]);
  });
});
