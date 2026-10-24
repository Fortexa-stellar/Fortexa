import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkPackageLock,
  checkPackageManifest,
  classifyDependencySource,
  formatDependencyFinding,
  scanDependencyFiles,
} from "./check-dependency-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = resolve(__dirname, "check-dependency-sources.mjs");

describe("classifyDependencySource", () => {
  it("accepts standard registry semver ranges and npm aliases", () => {
    expect(classifyDependencySource("^16.0.1")).toBeNull();
    expect(classifyDependencySource("~4.2.2")).toBeNull();
    expect(classifyDependencySource(">=1.0.0 <2.0.0")).toBeNull();
    expect(classifyDependencySource("https://registry.npmjs.org/zod/-/zod-4.3.6.tgz")).toBeNull();
    expect(classifyDependencySource("npm:@stellar/stellar-sdk@^16.0.1")).toBeNull();
  });

  it("rejects git+ and git:// dependency sources", () => {
    expect(classifyDependencySource("git+https://github.com/org/pkg.git#v1.0.0")).toBe("git-source");
    expect(classifyDependencySource("git+ssh://git@github.com:org/pkg.git")).toBe("git-source");
    expect(classifyDependencySource("git://github.com/org/pkg.git")).toBe("git-source");
  });

  it("rejects GitHub and hosted git shorthand specifiers", () => {
    expect(classifyDependencySource("github:org/pkg#main")).toBe("github-shorthand");
    expect(classifyDependencySource("gitlab:org/pkg")).toBe("github-shorthand");
    expect(classifyDependencySource("bitbucket:org/pkg")).toBe("github-shorthand");
    expect(classifyDependencySource("org/pkg")).toBe("github-shorthand");
    expect(classifyDependencySource("org/pkg#deadbeef")).toBe("github-shorthand");
  });

  it("rejects file: and link: local dependency sources", () => {
    expect(classifyDependencySource("file:../local-pkg")).toBe("file-source");
    expect(classifyDependencySource("file:./vendor/pkg.tgz")).toBe("file-source");
    expect(classifyDependencySource("link:../linked-pkg")).toBe("link-source");
  });
});

describe("checkPackageManifest", () => {
  it("flags git+, GitHub shorthand, file:, and link: across dependency sections and overrides", () => {
    const manifest = {
      dependencies: {
        zod: "^4.3.6",
        "git-dep": "git+https://github.com/evil/pkg.git",
        "gh-dep": "owner/repo#v1",
      },
      devDependencies: {
        "file-dep": "file:./local-dev",
      },
      optionalDependencies: {
        "link-dep": "link:../local-link",
      },
      overrides: {
        nested: {
          "override-git": "github:evil/override",
        },
      },
    };

    expect(checkPackageManifest(manifest)).toEqual([
      {
        file: "package.json",
        location: "dependencies.git-dep",
        package: "git-dep",
        source: "git+https://github.com/evil/pkg.git",
        rule: "git-source",
      },
      {
        file: "package.json",
        location: "dependencies.gh-dep",
        package: "gh-dep",
        source: "owner/repo#v1",
        rule: "github-shorthand",
      },
      {
        file: "package.json",
        location: "devDependencies.file-dep",
        package: "file-dep",
        source: "file:./local-dev",
        rule: "file-source",
      },
      {
        file: "package.json",
        location: "optionalDependencies.link-dep",
        package: "link-dep",
        source: "link:../local-link",
        rule: "link-source",
      },
      {
        file: "package.json",
        location: "overrides.nested.override-git",
        package: "override-git",
        source: "github:evil/override",
        rule: "github-shorthand",
      },
    ]);
  });

  it("permits explicitly reviewed sources when present in the allowlist", () => {
    const manifest = {
      dependencies: {
        "reviewed-pkg": "github:trusted/reviewed-pkg#1234567",
      },
    };

    expect(
      checkPackageManifest(manifest, "package.json", {
        allowlist: [{ name: "reviewed-pkg", source: "github:trusted/reviewed-pkg#1234567" }],
      }),
    ).toEqual([]);
  });
});

describe("checkPackageLock", () => {
  it("flags git+, GitHub shorthand, file:, and link: entries in lockfile packages", () => {
    const lockfile = {
      name: "fortexa",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fortexa",
          version: "1.0.0",
          dependencies: {
            zod: "^4.3.6",
          },
        },
        "node_modules/zod": {
          version: "4.3.6",
          resolved: "https://registry.npmjs.org/zod/-/zod-4.3.6.tgz",
        },
        "node_modules/evil-git": {
          version: "1.0.0",
          resolved: "git+ssh://git@github.com/evil/repo.git#deadbeef",
        },
        "node_modules/evil-file": {
          version: "1.0.0",
          resolved: "file:../evil-file",
        },
        "node_modules/evil-link": {
          resolved: "../evil-link",
          link: true,
        },
      },
    };

    expect(checkPackageLock(lockfile)).toEqual([
      {
        file: "package-lock.json",
        location: 'packages["node_modules/evil-git"].resolved',
        package: "evil-git",
        source: "git+ssh://git@github.com/evil/repo.git#deadbeef",
        rule: "git-source",
      },
      {
        file: "package-lock.json",
        location: 'packages["node_modules/evil-file"].resolved',
        package: "evil-file",
        source: "file:../evil-file",
        rule: "file-source",
      },
      {
        file: "package-lock.json",
        location: 'packages["node_modules/evil-link"].link',
        package: "evil-link",
        source: "link:../evil-link",
        rule: "link-source",
      },
    ]);
  });
});

describe("CLI and repository integration (#349)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fortexa-dep-sources-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 for clean manifest + lockfile and 1 when disallowed sources exist", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { zod: "^4.3.6" } }),
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { zod: "^4.3.6" } },
          "node_modules/zod": {
            version: "4.3.6",
            resolved: "https://registry.npmjs.org/zod/-/zod-4.3.6.tgz",
          },
        },
      }),
    );

    const clean = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    expect(clean.status).toBe(0);

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { zod: "file:../zod" } }),
    );
    const dirty = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toContain("file-source");
  });

  it("exits 2 when manifest or lockfile is missing", () => {
    const missing = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    expect(missing.status).toBe(2);
  });

  it("passes on this repository's package.json and package-lock.json", () => {
    expect(scanDependencyFiles(REPO_ROOT).map(formatDependencyFinding)).toEqual([]);
  });

  it("wires check:deps:sources into package.json and is covered by the blocking CI test step", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["check:deps:sources"]).toBe(
      "node scripts/check-dependency-sources.mjs",
    );

    const ci = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/name:\s*Test\s*\n\s*run:\s*npm run test/);
  });
});
