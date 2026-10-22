import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const LICENSE_PATH = resolve(REPO_ROOT, "LICENSE");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");
const README_PATH = resolve(REPO_ROOT, "README.md");

/** Canonical MIT clauses that must appear verbatim in the license text. */
const MIT_CLAUSES = [
  "MIT License",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "The above copyright notice and this permission notice shall be included in all",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("repository license", () => {
  it("ships a LICENSE file at the repository root", () => {
    expect(existsSync(LICENSE_PATH), "LICENSE file missing at repo root").toBe(
      true
    );
  });

  it("LICENSE contains the canonical MIT text", () => {
    const license = read(LICENSE_PATH);
    for (const clause of MIT_CLAUSES) {
      expect(license, `missing MIT clause: ${clause}`).toContain(clause);
    }
  });

  it("LICENSE carries a copyright line", () => {
    const license = read(LICENSE_PATH);
    expect(license).toMatch(/Copyright \(c\) \d{4} .+/);
  });

  it("package.json declares MIT, matching the LICENSE file", () => {
    const pkg = JSON.parse(read(PACKAGE_JSON_PATH)) as { license?: string };
    expect(pkg.license).toBe("MIT");
    expect(read(LICENSE_PATH)).toContain("MIT License");
  });

  it("README links to the LICENSE file", () => {
    const readme = read(README_PATH);
    expect(readme).toMatch(/\[[^\]]*\]\(\.?\/?LICENSE\)/);
  });
});
