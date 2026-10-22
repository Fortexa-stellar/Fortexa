import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

import {
  findDuplicateEnvKeys,
  formatDuplicateReport,
} from "./check-env-duplicates.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "check-env-duplicates.mjs");

function runScript(contents: string) {
  const dir = mkdtempSync(join(tmpdir(), "env-dup-"));
  const filePath = join(dir, ".env.example");
  writeFileSync(filePath, contents);
  return spawnSync(process.execPath, [SCRIPT, filePath], { encoding: "utf8" });
}

describe("findDuplicateEnvKeys", () => {
  it("accepts unique keys", () => {
    const content = ["FOO=1", "BAR=2", "FOO_BAR=3"].join("\n");
    expect(findDuplicateEnvKeys(content)).toEqual([]);
  });

  it("reports duplicate keys with line numbers", () => {
    const content = ["FOO=1", "BAR=2", "FOO=3"].join("\n");
    const duplicates = findDuplicateEnvKeys(content);
    expect(duplicates).toEqual([{ key: "FOO", lines: [1, 3] }]);
    expect(formatDuplicateReport(duplicates)).toBe("Duplicate key FOO at lines 1, 3");
  });

  it("ignores full-line comments", () => {
    const content = ["# FOO=1", "  # BAR=2", "FOO=1", "BAR=two"].join("\n");
    expect(findDuplicateEnvKeys(content)).toEqual([]);
  });

  it("ignores blank lines and still uses real line numbers", () => {
    const content = ["# header", "", "FOO=1", "", "# FOO=ignored", "", "FOO=2"].join("\n");
    expect(findDuplicateEnvKeys(content)).toEqual([{ key: "FOO", lines: [3, 7] }]);
  });

  it("accepts the repository .env.example", () => {
    const content = readFileSync(resolve(__dirname, "../.env.example"), "utf8");
    expect(findDuplicateEnvKeys(content)).toEqual([]);
  });
});

describe("check-env-duplicates CLI", () => {
  it("exits 0 when keys are unique, including comments and blanks", () => {
    const result = runScript("# comment\n\nALPHA=1\n\nBETA=\n");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("exits non-zero and prints duplicate line numbers", () => {
    const result = runScript("ALPHA=1\n\n# ALPHA=skip\nALPHA=2\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Duplicate key ALPHA at lines 1, 4");
  });
});
