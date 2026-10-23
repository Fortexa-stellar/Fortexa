import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import * as prettier from "prettier";

describe("Deterministic formatting check configuration (#346)", () => {
  const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

  it("defines a valid .prettierrc configuration with deterministic rules", () => {
    const configPath = resolve(rootDir, ".prettierrc");
    expect(existsSync(configPath)).toBe(true);

    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    expect(config.semi).toBe(true);
    expect(config.singleQuote).toBe(false);
    expect(config.tabWidth).toBe(2);
    expect(config.trailingComma).toBe("es5");
    expect(config.printWidth).toBe(100);
  });

  it("provides a .prettierignore file covering build outputs and dependencies", () => {
    const ignorePath = resolve(rootDir, ".prettierignore");
    expect(existsSync(ignorePath)).toBe(true);

    const ignoreContent = readFileSync(ignorePath, "utf-8");
    const ignoredPatterns = ignoreContent.split("\n").map((line) => line.trim());

    expect(ignoredPatterns).toContain("node_modules");
    expect(ignoredPatterns).toContain(".next");
    expect(ignoredPatterns).toContain("coverage");
    expect(ignoredPatterns).toContain("package-lock.json");
  });

  it("exposes a non-mutating format:check script in package.json", () => {
    const packageJsonPath = resolve(rootDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    expect(packageJson.scripts).toBeDefined();
    expect(packageJson.scripts["format:check"]).toBeDefined();
    expect(packageJson.scripts["format:check"]).toContain("prettier --check");
    expect(packageJson.scripts["format:check"]).not.toContain("--write");

    expect(packageJson.devDependencies).toBeDefined();
    expect(packageJson.devDependencies.prettier).toBeDefined();
  });

  it("includes format:check in the CI workflow", () => {
    const ciWorkflowPath = resolve(rootDir, ".github/workflows/ci.yml");
    expect(existsSync(ciWorkflowPath)).toBe(true);

    const ciContent = readFileSync(ciWorkflowPath, "utf-8");
    expect(ciContent).toMatch(/run:\s*npm run format:check/);
  });

  it("executes repository-wide format:check subprocess successfully with exit status 0", () => {
    const output = execSync("npm run format:check", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    expect(output).toContain("All matched files use Prettier code style!");
  }, 30000);

  it("verifies Prettier check works deterministically without mutating files", async () => {
    const configPath = resolve(rootDir, ".prettierrc");
    const prettierOptions = JSON.parse(readFileSync(configPath, "utf-8"));

    const compliantCode = `export const add = (a: number, b: number): number => {\n  return a + b;\n};\n`;
    const unformattedCode = `export  const  add=( a:number,b:number ):number=>{return a+b;}`;

    const isCompliant = await prettier.check(compliantCode, {
      ...prettierOptions,
      parser: "typescript",
    });
    const isUnformatted = await prettier.check(unformattedCode, {
      ...prettierOptions,
      parser: "typescript",
    });

    expect(isCompliant).toBe(true);
    expect(isUnformatted).toBe(false);
  });
});
