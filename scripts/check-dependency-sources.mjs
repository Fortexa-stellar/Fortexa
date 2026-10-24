#!/usr/bin/env node
/**
 * check-dependency-sources.mjs
 * ============================
 * Verifies that `package.json` and `package-lock.json` only reference
 * reviewed registry dependency sources and reject unreviewed `git+`,
 * GitHub shorthand (`github:owner/repo` or `owner/repo`), `file:`, and
 * `link:` dependency sources.
 *
 * Usage
 * -----
 *   node scripts/check-dependency-sources.mjs          # scan cwd repo
 *   node scripts/check-dependency-sources.mjs <dir>    # scan <dir>
 *   npm run check:deps:sources                         # via npm script
 *
 * Exit codes
 * ----------
 *   0  No unreviewed git or local-file dependency sources found.
 *   1  One or more disallowed dependency sources were found.
 *   2  Manifest or lockfile could not be read or parsed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Explicitly reviewed dependency source exceptions (`{ name, source }`).
 * Empty by default; add an entry only after security review and lockfile pinning.
 *
 * @type {ReadonlyArray<{ name: string, source: string, reason?: string }>}
 */
export const REVIEWED_DEPENDENCY_SOURCES = Object.freeze([]);

const MANIFEST_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const GIT_PROTOCOL_RE = /^(?:git\+[a-z][a-z0-9+.-]*:|git:\/\/|ssh:\/\/git@|[a-z0-9+.-]+:\/\/[^/\s]*github\.com\/.*\.git(?:#.*)?$)/i;
const HOSTED_SHORTHAND_PREFIX_RE = /^(?:github|gitlab|bitbucket|gist):/i;
const GITHUB_OWNER_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+(?:#.*)?$/;
const FILE_PREFIX_RE = /^(?:file:|\.\.?\/|\/)/i;
const LINK_PREFIX_RE = /^link:/i;

/**
 * Classifies a dependency version specifier or lockfile resolved URL.
 * Returns the violated rule name, or `null` when the source is allowed.
 *
 * @param {string} rawSpecifier
 * @returns {"git-source" | "github-shorthand" | "file-source" | "link-source" | null}
 */
export function classifyDependencySource(rawSpecifier) {
  if (typeof rawSpecifier !== "string") return null;
  const spec = rawSpecifier.trim();
  if (spec.length === 0) return null;

  if (FILE_PREFIX_RE.test(spec)) return "file-source";
  if (LINK_PREFIX_RE.test(spec)) return "link-source";
  if (GIT_PROTOCOL_RE.test(spec)) return "git-source";
  if (HOSTED_SHORTHAND_PREFIX_RE.test(spec)) return "github-shorthand";

  // Scoped npm packages (@scope/pkg) or npm: aliases with registry semver are allowed;
  // bare `owner/repo` or `owner/repo#ref` in a version/specifier field is GitHub shorthand.
  if (spec.startsWith("npm:")) {
    const inner = spec.slice(4).trim();
    const atIndex = inner.lastIndexOf("@");
    if (atIndex > 0) {
      return classifyDependencySource(inner.slice(atIndex + 1));
    }
    return classifyDependencySource(inner);
  }

  if (!spec.startsWith("@") && GITHUB_OWNER_REPO_RE.test(spec)) {
    return "github-shorthand";
  }

  return null;
}

function isAllowed(name, source, allowlist) {
  return allowlist.some((entry) => entry.name === name && entry.source === source);
}

/**
 * Inspects a parsed `package.json` manifest for disallowed dependency sources.
 *
 * @param {Record<string, unknown>} manifest
 * @param {string} [filePath="package.json"]
 * @param {{ allowlist?: ReadonlyArray<{ name: string, source: string }> }} [options]
 */
export function checkPackageManifest(manifest, filePath = "package.json", options = {}) {
  const allowlist = options.allowlist ?? REVIEWED_DEPENDENCY_SOURCES;
  const findings = [];

  for (const section of MANIFEST_SECTIONS) {
    const deps = manifest?.[section];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;

    for (const [name, rawSpec] of Object.entries(deps)) {
      if (typeof rawSpec !== "string") continue;
      const rule = classifyDependencySource(rawSpec);
      if (rule && !isAllowed(name, rawSpec, allowlist)) {
        findings.push({
          file: filePath,
          location: `${section}.${name}`,
          package: name,
          source: rawSpec,
          rule,
        });
      }
    }
  }

  function walkOverrides(node, pathPrefix) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const currentPath = `${pathPrefix}.${key}`;
      if (typeof value === "string") {
        const rule = classifyDependencySource(value);
        if (rule && !isAllowed(key, value, allowlist)) {
          findings.push({
            file: filePath,
            location: currentPath,
            package: key,
            source: value,
            rule,
          });
        }
      } else if (value && typeof value === "object") {
        walkOverrides(value, currentPath);
      }
    }
  }

  if (manifest?.overrides) {
    walkOverrides(manifest.overrides, "overrides");
  }

  return findings;
}

function packageNameFromLockKey(lockKey, entry) {
  if (typeof entry?.name === "string" && entry.name.length > 0) {
    return entry.name;
  }
  const parts = lockKey.split("node_modules/");
  return parts[parts.length - 1] || lockKey;
}

/**
 * Inspects a parsed `package-lock.json` lockfile for disallowed dependency sources.
 *
 * @param {Record<string, unknown>} lockfile
 * @param {string} [filePath="package-lock.json"]
 * @param {{ allowlist?: ReadonlyArray<{ name: string, source: string }> }} [options]
 */
export function checkPackageLock(lockfile, filePath = "package-lock.json", options = {}) {
  const allowlist = options.allowlist ?? REVIEWED_DEPENDENCY_SOURCES;
  const findings = [];

  const packages = lockfile?.packages;
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    for (const [pkgKey, entry] of Object.entries(packages)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

      if (pkgKey === "") {
        // Root package entry in lockfile v2/v3 mirrors manifest sections
        for (const section of MANIFEST_SECTIONS) {
          const deps = entry[section];
          if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
          for (const [name, rawSpec] of Object.entries(deps)) {
            if (typeof rawSpec !== "string") continue;
            const rule = classifyDependencySource(rawSpec);
            if (rule && !isAllowed(name, rawSpec, allowlist)) {
              findings.push({
                file: filePath,
                location: `packages[""].${section}.${name}`,
                package: name,
                source: rawSpec,
                rule,
              });
            }
          }
        }
        continue;
      }

      const pkgName = packageNameFromLockKey(pkgKey, entry);

      if (entry.link === true) {
        const source = typeof entry.resolved === "string" ? `link:${entry.resolved}` : "link:true";
        if (!isAllowed(pkgName, source, allowlist) && !isAllowed(pkgName, entry.resolved ?? "", allowlist)) {
          findings.push({
            file: filePath,
            location: `packages["${pkgKey}"].link`,
            package: pkgName,
            source,
            rule: "link-source",
          });
        }
        continue;
      }

      if (typeof entry.resolved === "string") {
        const rule = classifyDependencySource(entry.resolved);
        if (rule && !isAllowed(pkgName, entry.resolved, allowlist)) {
          findings.push({
            file: filePath,
            location: `packages["${pkgKey}"].resolved`,
            package: pkgName,
            source: entry.resolved,
            rule,
          });
        }
      }

      if (typeof entry.version === "string") {
        const rule = classifyDependencySource(entry.version);
        if (rule && !isAllowed(pkgName, entry.version, allowlist)) {
          findings.push({
            file: filePath,
            location: `packages["${pkgKey}"].version`,
            package: pkgName,
            source: entry.version,
            rule,
          });
        }
      }
    }
  }

  function walkLegacyDeps(depsMap, prefix) {
    if (!depsMap || typeof depsMap !== "object" || Array.isArray(depsMap)) return;
    for (const [name, entry] of Object.entries(depsMap)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const loc = `${prefix}.${name}`;
      for (const field of ["version", "resolved", "from"]) {
        const val = entry[field];
        if (typeof val !== "string") continue;
        const rule = classifyDependencySource(val);
        if (rule && !isAllowed(name, val, allowlist)) {
          findings.push({
            file: filePath,
            location: `${loc}.${field}`,
            package: name,
            source: val,
            rule,
          });
        }
      }
      if (entry.dependencies) {
        walkLegacyDeps(entry.dependencies, `${loc}.dependencies`);
      }
    }
  }

  if (lockfile?.dependencies) {
    walkLegacyDeps(lockfile.dependencies, "dependencies");
  }

  return findings;
}

/**
 * Scans `package.json` and `package-lock.json` under `root`.
 *
 * @param {string} root
 * @param {{ allowlist?: ReadonlyArray<{ name: string, source: string }> }} [options]
 */
export function scanDependencyFiles(root, options = {}) {
  const manifestPath = resolve(root, "package.json");
  const lockfilePath = resolve(root, "package-lock.json");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8"));

  return [
    ...checkPackageManifest(manifest, "package.json", options),
    ...checkPackageLock(lockfile, "package-lock.json", options),
  ];
}

export function formatDependencyFinding(finding) {
  return `${finding.file} (${finding.location}): ${finding.rule} for "${finding.package}" -> ${finding.source}`;
}

function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  let findings;
  try {
    findings = scanDependencyFiles(root);
  } catch (error) {
    console.error(
      `check-dependency-sources: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  if (findings.length === 0) {
    console.log("check-dependency-sources: all manifest and lockfile sources are registry-pinned.");
    return 0;
  }

  console.error(`check-dependency-sources: ${findings.length} disallowed dependency source(s):`);
  for (const finding of findings) {
    console.error(`  ${formatDependencyFinding(finding)}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
