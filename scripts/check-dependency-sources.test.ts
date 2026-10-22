import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  checkDependencySpec,
  scanPackageLock,
  scanPackageManifest,
  scanRepositoryDependencySources,
} from "./check-dependency-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

describe("Reject unreviewed dependency sources (#349)", () => {
  describe("checkDependencySpec", () => {
    it("allows standard semver version ranges and tags", () => {
      expect(checkDependencySpec("^1.0.0")).toBeNull();
      expect(checkDependencySpec("~2.14.3")).toBeNull();
      expect(checkDependencySpec(">=18.0.0")).toBeNull();
      expect(checkDependencySpec("1.0.0")).toBeNull();
      expect(checkDependencySpec("*")).toBeNull();
      expect(checkDependencySpec("latest")).toBeNull();
    });

    it("rejects git+ protocols", () => {
      const httpsResult = checkDependencySpec("git+https://github.com/stellar/js-stellar-sdk.git");
      expect(httpsResult).not.toBeNull();
      expect(httpsResult?.rule).toBe("git-protocol");

      const sshResult = checkDependencySpec("git+ssh://git@github.com:foo/bar.git#v1.0.0");
      expect(sshResult).not.toBeNull();
      expect(sshResult?.rule).toBe("git-protocol");

      const gitResult = checkDependencySpec("git://github.com/foo/bar.git");
      expect(gitResult).not.toBeNull();
      expect(gitResult?.rule).toBe("git-protocol");
    });

    it("rejects GitHub shorthand and github: URLs", () => {
      const shorthandResult = checkDependencySpec("expressjs/express#v4.18.2");
      expect(shorthandResult).not.toBeNull();
      expect(shorthandResult?.rule).toBe("github-shorthand");

      const githubPrefixResult = checkDependencySpec("github:org/unreviewed-repo");
      expect(githubPrefixResult).not.toBeNull();
      expect(githubPrefixResult?.rule).toBe("github-shorthand");
    });

    it("rejects local file: and link: protocols", () => {
      const fileResult = checkDependencySpec("file:../local-package");
      expect(fileResult).not.toBeNull();
      expect(fileResult?.rule).toBe("file-protocol");

      const linkResult = checkDependencySpec("link:../../shared-lib");
      expect(linkResult).not.toBeNull();
      expect(linkResult?.rule).toBe("link-protocol");
    });
  });

  describe("scanPackageManifest", () => {
    it("detects unreviewed dependency sources in package.json", () => {
      const mockPkg = {
        name: "test-pkg",
        dependencies: {
          "safe-dep": "^1.0.0",
          "git-dep": "git+https://github.com/foo/bar.git",
          "file-dep": "file:./local-dep",
        },
        devDependencies: {
          "link-dep": "link:../shared-tools",
          "github-dep": "user/repo#main",
        },
      };

      const findings = scanPackageManifest(mockPkg);
      expect(findings).toHaveLength(4);
      expect(findings.map((f) => f.rule)).toEqual([
        "git-protocol",
        "file-protocol",
        "link-protocol",
        "github-shorthand",
      ]);
    });
  });

  describe("scanPackageLock", () => {
    it("detects unreviewed dependency sources in lockfile packages", () => {
      const mockLock = {
        name: "test-pkg",
        lockfileVersion: 3,
        packages: {
          "node_modules/safe-dep": {
            version: "1.0.0",
            resolved: "https://registry.npmjs.org/safe-dep/-/safe-dep-1.0.0.tgz",
          },
          "node_modules/unreviewed-git": {
            version: "git+https://github.com/attacker/malicious.git#abcdef",
            resolved: "git+https://github.com/attacker/malicious.git#abcdef",
          },
          "node_modules/unreviewed-file": {
            resolved: "file:../local-pkg",
          },
        },
      };

      const findings = scanPackageLock(mockLock);
      expect(findings.length).toBeGreaterThanOrEqual(2);
      expect(findings.some((f) => f.rule === "git-protocol")).toBe(true);
      expect(findings.some((f) => f.rule === "file-protocol")).toBe(true);
    });
  });

  describe("repository check integration", () => {
    it("passes cleanly on the current repository", () => {
      const result = scanRepositoryDependencySources(REPO_ROOT);
      expect(result.clean).toBe(true);
      expect(result.findings).toHaveLength(0);
    });

    it("has check:dependency-sources defined in package.json", () => {
      const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
      expect(pkg.scripts["check:dependency-sources"]).toBe("node scripts/check-dependency-sources.mjs");
    });

    it("includes dependency sources check step in .github/workflows/ci.yml", () => {
      const ci = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf-8");
      expect(ci).toMatch(/run:\s*npm run check:dependency-sources/);
    });
  });
});
