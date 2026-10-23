import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("CI concurrency", () => {
  it("cancels superseded runs on the same branch", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toMatch(/concurrency:\s*\n\s*group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n\s*cancel-in-progress: true/);
  });
});
