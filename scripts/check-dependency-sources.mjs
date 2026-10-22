#!/usr/bin/env node
/**
 * check-dependency-sources.mjs
 * ============================
 * Supply-chain security guard for Fortexa.
 *
 * Verifies that package.json and package-lock.json do not contain unreviewed
 * dependency sources such as:
 *   - git+ protocols (git+https:, git+ssh:, git://)
 *   - GitHub shorthand (user/repo, github:user/repo)
 *   - Local filesystem URLs (file:../path)
 *   - Local symlinks (link:../path)
 *
 * Usage
 * -----
 *   node scripts/check-dependency-sources.mjs
 *   npm run check:dependency-sources
 *
 * Exit codes
 * ----------
 *   0  All dependency sources are approved registry packages.
 *   1  One or more unreviewed dependency sources found.
 *   2  Manifest or lockfile could not be read or parsed.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/**
 * Rules defining unreviewed dependency patterns.
 */
export const UNREVIEWED_SOURCE_RULES = [
  {
    rule: "git-protocol",
    pattern: /^git(\+(https|ssh|file))?:\/\//i,
    description: "Unreviewed git protocol source",
  },
  {
    rule: "github-shorthand",
    pattern: /^(github:|[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+(#.*)?$)/i,
    description: "GitHub shorthand dependency reference",
  },
  {
    rule: "file-protocol",
    pattern: /^file:/i,
    description: "Local filesystem file: dependency reference",
  },
  {
    rule: "link-protocol",
    pattern: /^link:/i,
    description: "Local filesystem link: dependency reference",
  },
];

/**
 * Checks a single dependency specification string against unreviewed source rules.
 * @param {string} spec - Version or source specifier
 * @returns {object|null} - Matched rule or null
 */
export function checkDependencySpec(spec) {
  if (typeof spec !== "string") return null;
  const trimmed = spec.trim();

  // Exclude standard scoped package names like @stellar/stellar-sdk or @types/node
  if (trimmed.startsWith("@") && !trimmed.startsWith("git+") && !trimmed.startsWith("github:")) {
    // Standard semver version range on a scoped package
    return null;
  }

  // Check if it's a standard semver range or tag (starts with ^, ~, >=, <=, v, digit, *, etc.)
  if (/^(\^|~|>=|<=|>|<|=|v)?\d+/i.test(trimmed) || trimmed === "*" || trimmed === "latest") {
    return null;
  }

  // Check against unreviewed rules
  for (const ruleObj of UNREVIEWED_SOURCE_RULES) {
    if (ruleObj.pattern.test(trimmed)) {
      return ruleObj;
    }
  }

  return null;
}

/**
 * Scans a parsed package.json object for unreviewed dependency sources.
 * @param {object} pkg - Parsed package.json
 * @returns {Array<object>} - Array of findings
 */
export function scanPackageManifest(pkg) {
  const findings = [];
  const depSections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];

  for (const section of depSections) {
    const deps = pkg[section];
    if (!deps || typeof deps !== "object") continue;

    for (const [name, spec] of Object.entries(deps)) {
      const match = checkDependencySpec(spec);
      if (match) {
        findings.push({
          location: `package.json -> ${section} -> ${name}`,
          package: name,
          spec,
          rule: match.rule,
          description: match.description,
        });
      }
    }
  }

  return findings;
}

/**
 * Scans a parsed package-lock.json object for unreviewed dependency sources.
 * @param {object} lock - Parsed package-lock.json
 * @returns {Array<object>} - Array of findings
 */
export function scanPackageLock(lock) {
  const findings = [];
  const packages = lock.packages || {};

  for (const [pkgPath, pkgData] of Object.entries(packages)) {
    if (!pkgData || typeof pkgData !== "object") continue;

    // Check resolved URL
    if (pkgData.resolved && typeof pkgData.resolved === "string") {
      const resolved = pkgData.resolved.trim();
      for (const ruleObj of UNREVIEWED_SOURCE_RULES) {
        if (ruleObj.pattern.test(resolved)) {
          findings.push({
            location: `package-lock.json -> packages["${pkgPath}"].resolved`,
            package: pkgData.name || pkgPath,
            spec: resolved,
            rule: ruleObj.rule,
            description: ruleObj.description,
          });
          break;
        }
      }
    }

    // Check version field if resolved is absent or points to git/file
    if (pkgData.version && typeof pkgData.version === "string") {
      const match = checkDependencySpec(pkgData.version);
      if (match) {
        findings.push({
          location: `package-lock.json -> packages["${pkgPath}"].version`,
          package: pkgData.name || pkgPath,
          spec: pkgData.version,
          rule: match.rule,
          description: match.description,
        });
      }
    }
  }

  return findings;
}

/**
 * Performs full scan of the repository manifest and lockfile.
 * @param {string} rootDir
 * @returns {{ findings: Array, clean: boolean }}
 */
export function scanRepositoryDependencySources(rootDir = REPO_ROOT) {
  const pkgPath = resolve(rootDir, "package.json");
  const lockPath = resolve(rootDir, "package-lock.json");

  const findings = [];

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      findings.push(...scanPackageManifest(pkg));
    } catch (err) {
      console.error(`Failed to parse ${pkgPath}:`, err.message);
      return { findings, clean: false, error: err };
    }
  }

  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
      findings.push(...scanPackageLock(lock));
    } catch (err) {
      console.error(`Failed to parse ${lockPath}:`, err.message);
      return { findings, clean: false, error: err };
    }
  }

  return {
    findings,
    clean: findings.length === 0,
  };
}

/**
 * CLI execution function.
 */
export function main() {
  console.log("[check:dependency-sources] Verifying dependency sources in manifest and lockfile...");
  const result = scanRepositoryDependencySources();

  if (result.error) {
    process.exit(2);
  }

  if (!result.clean) {
    console.error(`\n❌ [FAIL] Found ${result.findings.length} unreviewed dependency source(s):`);
    for (const f of result.findings) {
      console.error(`  - [${f.rule}] ${f.location}: "${f.spec}"`);
      console.error(`    ${f.description}`);
    }
    console.error("\nRemediation required:");
    console.error("All dependencies must use reviewed registry packages (npm:^x.y.z).");
    console.error("Direct git+, github:, file:, and link: dependencies are rejected in CI.\n");
    process.exit(1);
  }

  console.log("✅ [PASS] All dependency sources in package.json and package-lock.json are valid.");
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
