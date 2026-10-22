import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_LINE_LENGTH,
  checkFiles,
  checkRoot,
  findConfigFiles,
  findOversizedLines,
  formatViolation,
  isIgnoredPath,
  isScannedConfigFile,
} from "./check-config-line-lengths.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(__dirname, "check-config-line-lengths.mjs");
const FIXTURES = resolve(__dirname, "fixtures", "config-line-lengths");

describe("isScannedConfigFile", () => {
  it("accepts every guarded config family and package.json", () => {
    for (const name of ["next", "postcss", "eslint", "tailwind", "vitest"]) {
      for (const ext of ["js", "cjs", "mjs", "ts", "cts", "mts"]) {
        expect(isScannedConfigFile(`${name}.config.${ext}`)).toBe(true);
      }
    }
    expect(isScannedConfigFile("package.json")).toBe(true);
  });

  it("rejects lockfiles and unrelated files", () => {
    expect(isScannedConfigFile("package-lock.json")).toBe(false);
    expect(isScannedConfigFile("npm-shrinkwrap.json")).toBe(false);
    expect(isScannedConfigFile("tsconfig.json")).toBe(false);
    expect(isScannedConfigFile("tailwind.css")).toBe(false);
  });
});

describe("isIgnoredPath", () => {
  it("ignores lockfiles and generated or vendor directories", () => {
    expect(isIgnoredPath("package-lock.json")).toBe(true);
    expect(isIgnoredPath("node_modules/pkg/package.json")).toBe(true);
    expect(isIgnoredPath(".next/next.config.js")).toBe(true);
    expect(isIgnoredPath("coverage/vitest.config.ts")).toBe(true);
  });

  it("keeps normal repository-root config paths", () => {
    expect(isIgnoredPath("next.config.ts")).toBe(false);
    expect(isIgnoredPath("package.json")).toBe(false);
  });
});

describe("findOversizedLines", () => {
  it("accepts a line exactly at the 500-character threshold", () => {
    expect(findOversizedLines("a".repeat(MAX_LINE_LENGTH))).toEqual([]);
  });

  it("reports lines over the threshold with their physical line number", () => {
    const content = `short\n${" ".repeat(MAX_LINE_LENGTH + 1)}\r\nexport default {};\n`;
    expect(findOversizedLines(content)).toEqual([
      { line: 2, length: MAX_LINE_LENGTH + 1 },
    ]);
  });
});

describe("findConfigFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fortexa-config-lines-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(path: string, content: string) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  it("finds guarded root config files and package.json only", () => {
    write("next.config.ts", "export default {};\n");
    write("tailwind.config.mjs", "export default {};\n");
    write("package.json", "{}\n");
    write("package-lock.json", "{}\n");
    write("tsconfig.json", "{}\n");
    write("nested/vitest.config.ts", "export default {};\n");
    write(".next/next.config.js", "export default {};\n");

    expect(findConfigFiles(dir)).toEqual([
      "next.config.ts",
      "package.json",
      "tailwind.config.mjs",
    ]);
  });

  it("checks files relative to the root and reports violations", () => {
    write("next.config.ts", `export default {};\n${" ".repeat(MAX_LINE_LENGTH + 1)}\n`);
    write("package.json", "{}\n");

    expect(checkFiles(dir, ["package.json", "next.config.ts"])).toEqual([
      { file: "next.config.ts", line: 2, length: MAX_LINE_LENGTH + 1 },
    ]);
    expect(checkRoot(dir).violations).toHaveLength(1);
  });
});

describe("fixtures and the CLI", () => {
  function runCli(root: string) {
    return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
  }

  it("passes the normal fixture", () => {
    const result = runCli(join(FIXTURES, "normal"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("within 500 characters per line");
    expect(result.stderr).toBe("");
  });

  it("fails the whitespace-padded fixture with only the file and line number", () => {
    const result = runCli(join(FIXTURES, "whitespace-padded"));
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("next.config.mjs:4");
    expect(result.stderr).not.toContain("fortexaHiddenPayload");
    expect(result.stdout).toBe("");
  });

  it("exits 2 when the root does not exist", () => {
    expect(runCli(join(FIXTURES, "missing")).status).toBe(2);
  });

  it("formats a violation without exposing the line content", () => {
    expect(formatViolation({ file: "next.config.ts", line: 12, length: 501 })).toBe(
      "next.config.ts:12",
    );
  });
});

describe("this repository", () => {
  it("has no oversized config lines", () => {
    expect(checkRoot(REPO_ROOT).violations).toEqual([]);
  });
});
