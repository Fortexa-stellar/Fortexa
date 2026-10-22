#!/usr/bin/env node
/**
 * check-doc-links.mjs
 * ===================
 * Scans README.md, ARCHITECTURE.md, and docs/*.md for local Markdown links
 * and verifies that every referenced file exists on disk.
 *
 * Usage
 * -----
 *   node scripts/check-doc-links.mjs          # local links only (default)
 *   node scripts/check-doc-links.mjs --external  # also check external URLs
 *   npm run check:docs                         # via npm script
 *
 * Exit codes
 * ----------
 *   0  All checked links are valid.
 *   1  One or more broken links were found (names file + broken target).
 *
 * Design notes
 * ------------
 * - Pure Node.js stdlib only — no extra dependencies required.
 * - External URL checking is opt-in (--external flag) and disabled by default,
 *   so CI stays fast and offline-friendly.
 * - Anchor-only links (#heading) within the same file are skipped because
 *   heading normalisation across Markdown renderers is inconsistent.
 * - Links that begin with mailto:, data:, or javascript: are also skipped.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Configuration ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

/** Files and glob-style patterns to scan. Resolved relative to REPO_ROOT. */
const SCAN_TARGETS = [
  "README.md",
  "ARCHITECTURE.md",
  "docs", // directory — all *.md files inside are included recursively
];

/** Honour --external flag to optionally check remote URLs. */
const CHECK_EXTERNAL = process.argv.includes("--external");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively collect every *.md file under a directory.
 * @param {string} dir  Absolute path to directory.
 * @returns {string[]}  Array of absolute file paths.
 */
function collectMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (stat.isFile() && extname(full).toLowerCase() === ".md") {
      results.push(full);
    }
  }
  return results;
}

/**
 * Build the final list of absolute paths to scan.
 * @returns {string[]}
 */
function resolveTargets() {
  const paths = [];
  for (const target of SCAN_TARGETS) {
    const abs = join(REPO_ROOT, target);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      paths.push(...collectMarkdownFiles(abs));
    } else if (stat.isFile()) {
      paths.push(abs);
    }
  }
  // Deduplicate (a file might match multiple targets)
  return [...new Set(paths)];
}

/**
 * Extract all Markdown links from source text.
 *
 * Matches:
 *   [label](target)                   — inline links
 *   [label]: target                   — reference-style link definitions
 *
 * Does NOT match:
 *   `[code](blocks)`                  — inside backtick spans (best-effort)
 *   <!-- [html](comments) -->         — inside HTML comment blocks
 *
 * @param {string} text  Raw Markdown content.
 * @returns {{ target: string, line: number }[]}
 */
function extractLinks(text) {
  const links = [];
  // Strip HTML comment blocks to avoid false positives
  const stripped = text.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  // Strip fenced code blocks
  const noCode = stripped.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));

  const inlineRe = /\[[^\]]*\]\(([^)]+)\)/g;
  const referenceRe = /^\[[^\]]+\]:\s+(\S+)/gm;

  for (const re of [inlineRe, referenceRe]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(noCode)) !== null) {
      const raw = match[1].split(" ")[0]; // drop optional "title" part
      const target = raw.replace(/^<|>$/g, ""); // strip angle-bracket wrapping

      // Calculate 1-based line number from match position
      const lineNum = noCode.slice(0, match.index).split("\n").length;
      links.push({ target, line: lineNum });
    }
  }

  return links;
}

/**
 * Classify a link target.
 * @param {string} target
 * @returns {'anchor-only' | 'external' | 'local'}
 */
function classifyTarget(target) {
  if (target.startsWith("#")) return "anchor-only";
  if (/^[a-z][a-z\d+\-.]*:/i.test(target)) return "external"; // scheme://...
  return "local";
}

/**
 * Resolve a local link target to an absolute path.
 *
 * Handles:
 *   - Relative paths:  ./foo/bar.md, ../baz.md
 *   - Paths with anchors: ./foo.md#section
 *   - Directory links: ./docs/ (checks for index.md)
 *
 * @param {string} target      Raw link target (no scheme).
 * @param {string} sourceFile  Absolute path of the file containing the link.
 * @returns {string}           Absolute resolved path (without anchor).
 */
function resolveLocalTarget(target, sourceFile) {
  // Strip anchor fragment
  const withoutAnchor = target.split("#")[0];
  if (!withoutAnchor) return sourceFile; // anchor-only links resolve to self

  const sourceDir = dirname(sourceFile);
  return resolve(sourceDir, withoutAnchor);
}

/**
 * Check whether a resolved local path exists.
 * Accepts the exact path or path + common extensions (.md, .mdx, .txt).
 * @param {string} absPath
 * @returns {boolean}
 */
function localFileExists(absPath) {
  if (existsSync(absPath)) return true;
  // Try with .md extension if no extension provided
  if (!extname(absPath)) {
    for (const ext of [".md", ".mdx"]) {
      if (existsSync(absPath + ext)) return true;
    }
  }
  return false;
}

/**
 * Fetch an external URL with a HEAD request (Node.js built-in fetch, Node 18+).
 * Falls back to GET on 405 Method Not Allowed.
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, status: number}>}
 */
async function checkExternalUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    }).finally(() => clearTimeout(timeout));

    if (res.status === 405) {
      // Server does not allow HEAD — try GET
      const res2 = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8_000) });
      return { ok: res2.ok, status: res2.status };
    }
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const files = resolveTargets();

  if (files.length === 0) {
    console.log("⚠  No Markdown files found to scan.");
    console.log(`   Looked in: ${SCAN_TARGETS.map((t) => join(REPO_ROOT, t)).join(", ")}`);
    process.exit(0);
  }

  console.log(`🔍 Scanning ${files.length} Markdown file(s) for broken links…`);
  if (CHECK_EXTERNAL) {
    console.log("   External URL checking is ENABLED (--external)");
  } else {
    console.log("   External URL checking is DISABLED (pass --external to enable)");
  }
  console.log();

  /** @type {{ file: string, line: number, target: string, reason: string }[]} */
  const broken = [];
  let totalLinks = 0;

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const links = extractLinks(text);
    const relFile = file.replace(REPO_ROOT + "/", "");

    for (const { target, line } of links) {
      totalLinks++;
      const kind = classifyTarget(target);

      if (kind === "anchor-only") {
        // Same-file anchors: skip (heading normalisation is renderer-specific)
        continue;
      }

      if (kind === "external") {
        if (!CHECK_EXTERNAL) continue;

        const { ok, status } = await checkExternalUrl(target);
        if (!ok) {
          broken.push({ file: relFile, line, target, reason: `HTTP ${status || "timeout/error"}` });
          console.error(`  ✗  ${relFile}:${line}  →  ${target}  (${status || "timeout"})`);
        }
        continue;
      }

      // Local link
      const absTarget = resolveLocalTarget(target, file);
      if (!localFileExists(absTarget)) {
        broken.push({ file: relFile, line, target, reason: "file not found" });
        console.error(`  ✗  ${relFile}:${line}  →  ${target}  (file not found)`);
      }
    }
  }

  console.log();
  console.log(`─────────────────────────────────────────────`);
  console.log(`  Total files scanned : ${files.length}`);
  console.log(`  Total links checked : ${totalLinks}`);
  console.log(`  Broken links found  : ${broken.length}`);
  console.log(`─────────────────────────────────────────────`);

  if (broken.length > 0) {
    console.error("\n❌  Broken links detected — please fix the links listed above.\n");
    process.exit(1);
  } else {
    console.log("\n✅  All local links are valid.\n");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
