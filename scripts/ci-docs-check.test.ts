import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("documentation link check in CI", () => {
  it("runs npm run check:docs as a blocking step", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const step = workflow.slice(workflow.indexOf("name: Check documentation links"));
    expect(step.startsWith("name: Check documentation links")).toBe(true);
    expect(step).toMatch(/run: npm run check:docs/);
    const stepHead = step.slice(0, step.indexOf("run: npm run check:docs"));
    expect(stepHead).not.toMatch(/continue-on-error/);
  });
});
