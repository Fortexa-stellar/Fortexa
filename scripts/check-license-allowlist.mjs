#!/usr/bin/env node
/**
 * check-license-allowlist.mjs
 * ===========================
 * Production dependency license compliance scanner for Fortexa.
 *
 * Scans all production dependencies declared in package-lock.json,
 * generates a structured license breakdown report, and asserts that
 * all licenses comply with license-allowlist.json.
 *
 * Usage
 * -----
 *   node scripts/check-license-allowlist.mjs
 *   npm run check:licenses
 *
 * Exit codes
 * ----------
 *   0  All production dependencies comply with license allowlist.
 *   1  One or more unknown or disallowed licenses detected.
 *   2  Manifest or lockfile could not be read or parsed.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_ALLOWLIST_PATH = resolve(REPO_ROOT, "license-allowlist.json");

/**
 * Normalizes a raw license entry from package-lock into a canonical string.
 * @param {unknown} rawLicense
 * @returns {string}
 */
export function normalizeLicense(rawLicense) {
  if (!rawLicense) return "UNKNOWN";
  if (typeof rawLicense === "string") {
    const trimmed = rawLicense.trim();
    return trimmed.length > 0 ? trimmed : "UNKNOWN";
  }
  if (typeof rawLicense === "object") {
    if (rawLicense.type && typeof rawLicense.type === "string") {
      return rawLicense.type.trim();
    }
  }
  return "UNKNOWN";
}

/**
 * Loads the license allowlist configuration.
 * @param {string} configPath
 * @returns {{ allowedLicenses: string[], disallowedLicenses: string[], packageOverrides: Record<string, string> }}
 */
export function loadLicensePolicy(configPath = DEFAULT_ALLOWLIST_PATH) {
  if (!existsSync(configPath)) {
    return {
      allowedLicenses: ["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense"],
      disallowedLicenses: ["GPL-1.0", "GPL-2.0", "GPL-3.0", "AGPL-1.0", "AGPL-3.0"],
      packageOverrides: {},
    };
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse license policy from ${configPath}:`, err.message);
    process.exit(2);
  }
}

/**
 * Inspects lockfile and generates a production dependency license report.
 * @param {object} lock - Parsed package-lock.json
 * @param {object} policy - License policy object
 * @returns {{ packages: Array, licenseCounts: Record<string, number>, violations: Array, clean: boolean }}
 */
export function auditDependencyLicenses(lock, policy) {
  const packages = lock.packages || {};
  const allowedSet = new Set((policy.allowedLicenses || []).map((l) => l.toLowerCase()));
  const disallowedSet = new Set((policy.disallowedLicenses || []).map((l) => l.toLowerCase()));
  const overrides = policy.packageOverrides || {};

  const scannedPackages = [];
  const licenseCounts = {};
  const violations = [];

  for (const [pkgPath, pkgData] of Object.entries(packages)) {
    if (pkgPath === "") continue; // Skip root package
    if (pkgData.dev) continue; // Skip development-only dependencies

    const packageName = pkgData.name || pkgPath.replace(/^node_modules\//, "");
    let license = normalizeLicense(pkgData.license);

    // Check package-specific override
    if (overrides[packageName]) {
      license = overrides[packageName];
    }

    licenseCounts[license] = (licenseCounts[license] || 0) + 1;
    scannedPackages.push({
      path: pkgPath,
      name: packageName,
      version: pkgData.version,
      license,
    });

    const licenseLower = license.toLowerCase();

    // Check violation conditions: UNKNOWN, explicitly disallowed, or not in allowed list
    if (license === "UNKNOWN") {
      violations.push({
        path: pkgPath,
        name: packageName,
        version: pkgData.version,
        license,
        reason: "Missing or unidentifiable license (UNKNOWN)",
      });
    } else if (disallowedSet.has(licenseLower)) {
      violations.push({
        path: pkgPath,
        name: packageName,
        version: pkgData.version,
        license,
        reason: `Explicitly disallowed license (${license})`,
      });
    } else if (!allowedSet.has(licenseLower)) {
      violations.push({
        path: pkgPath,
        name: packageName,
        version: pkgData.version,
        license,
        reason: `License not in approved allowlist (${license})`,
      });
    }
  }

  return {
    packages: scannedPackages,
    licenseCounts,
    violations,
    clean: violations.length === 0,
  };
}

/**
 * Runs the full license audit and outputs report.
 * @param {object} options
 * @returns {number} Exit code
 */
export function runLicenseCheck(options = {}) {
  const rootDir = options.rootDir || REPO_ROOT;
  const configPath = options.configPath || resolve(rootDir, "license-allowlist.json");
  const lockPath = resolve(rootDir, "package-lock.json");

  console.log("[check:licenses] Generating production dependency license report...");

  if (!existsSync(lockPath)) {
    console.error(`package-lock.json not found at ${lockPath}`);
    return 2;
  }

  let lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch (err) {
    console.error("Failed to parse package-lock.json:", err.message);
    return 2;
  }

  const policy = loadLicensePolicy(configPath);
  const result = auditDependencyLicenses(lock, policy);

  console.log(`\n========================================`);
  console.log(`PRODUCTION DEPENDENCY LICENSE REPORT`);
  console.log(`========================================`);
  console.log(`Total production dependencies audited: ${result.packages.length}`);
  console.log(`\nLicense Distribution:`);

  const sortedLicenses = Object.entries(result.licenseCounts).sort((a, b) => b[1] - a[1]);
  for (const [license, count] of sortedLicenses) {
    console.log(`  - ${license.padEnd(45)}: ${count} package(s)`);
  }

  if (!result.clean) {
    console.error(`\n❌ [FAIL] Found ${result.violations.length} license compliance violation(s):`);
    for (const v of result.violations) {
      console.error(`  - ${v.name} (${v.version}) at ${v.path}`);
      console.error(`    License: ${v.license} | Reason: ${v.reason}`);
    }
    console.error("\nRemediation required:");
    console.error("1. Replace or remove dependencies using disallowed or unknown licenses.");
    console.error("2. If an approved license variation is permissible, update license-allowlist.json with justification.\n");
    return 1;
  }

  console.log(`\n✅ [PASS] All ${result.packages.length} production dependencies satisfy the license allowlist.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = runLicenseCheck();
  process.exit(code);
}
