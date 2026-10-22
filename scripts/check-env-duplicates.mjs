#!/usr/bin/env node
/**
 * check-env-duplicates.mjs
 * ========================
 * Rejects duplicate variable names in `.env.example`.
 *
 * Blank lines and full-line comments (optional whitespace, then `#`) are
 * ignored. Each `KEY=value` assignment is recorded with its 1-based line
 * number. If a key appears more than once, the script prints the key and
 * every line number, then exits 1. Unique keys exit 0.
 *
 * Usage
 * -----
 *   node scripts/check-env-duplicates.mjs
 *   node scripts/check-env-duplicates.mjs path/to/.env.example
 *   npm run check:env-duplicates
 *
 * CI runs this against the repository `.env.example` so a repeated name
 * cannot land quietly.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * @param {string} content
 * @returns {{ key: string, lines: number[] }[]}
 */
export function findDuplicateEnvKeys(content) {
  const seen = new Map();
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = ASSIGNMENT.exec(trimmed);
    if (!match) continue;

    const key = match[1];
    const lineNumber = index + 1;
    const previous = seen.get(key);
    if (previous) previous.push(lineNumber);
    else seen.set(key, [lineNumber]);
  }

  const duplicates = [];
  for (const [key, lineNumbers] of seen) {
    if (lineNumbers.length > 1) duplicates.push({ key, lines: lineNumbers });
  }
  return duplicates;
}

/**
 * @param {{ key: string, lines: number[] }[]} duplicates
 * @returns {string}
 */
export function formatDuplicateReport(duplicates) {
  return duplicates
    .map((entry) => `Duplicate key ${entry.key} at lines ${entry.lines.join(", ")}`)
    .join("\n");
}

function defaultEnvExamplePath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.example");
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

export function checkEnvFile(filePath) {
  const content = readFileSync(filePath, "utf8");
  const duplicates = findDuplicateEnvKeys(content);
  if (duplicates.length === 0) {
    return { ok: true, report: "" };
  }
  return { ok: false, report: formatDuplicateReport(duplicates) };
}

if (isDirectRun()) {
  const filePath = resolve(process.argv[2] ?? defaultEnvExamplePath());
  let result;
  try {
    result = checkEnvFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Cannot read ${filePath}: ${message}`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(result.report);
    process.exit(1);
  }

  console.log(`No duplicate keys in ${filePath}`);
}
