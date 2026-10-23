#!/usr/bin/env node
/**
 * check-config-line-lengths.mjs
 * ==============================
 * Flags executable configuration files with physical lines longer than
 * MAX_LINE_LENGTH characters. Long lines can hide appended code beyond
 * GitHub's normal diff viewport, after hundreds of spaces.
 *
 * Threshold
 * ---------
 * A line may be at most 500 characters long. Lines of 501 characters or
 * more are reported.
 *
 * Scanned files (repository root)
 * -------------------------------
 *   next.config.{js,cjs,mjs,ts,cts,mts}
 *   postcss.config.{js,cjs,mjs,ts,cts,mts}
 *   eslint.config.{js,cjs,mjs,ts,cts,mts}
 *   tailwind.config.{js,cjs,mjs,ts,cts,mts}
 *   vitest.config.{js,cjs,mjs,ts,cts,mts}
 *   package.json
 *
 * Excluded
 * --------
 *   - Lockfiles: package-lock.json, npm-shrinkwrap.json, yarn.lock,
 *     pnpm-lock.yaml, bun.lockb.
 *   - Generated or vendor output: node_modules, .next, out, build, dist,
 *     coverage, and .git. Configuration files are scanned at the repository
 *     root only, so these directories are never traversed.
 *
 * Usage
 * -----
 *   node scripts/check-config-line-lengths.mjs
 *   node scripts/check-config-line-lengths.mjs --root <dir>
 *   npm run check:config-line-lengths
 *
 * Output
 * ------
 *   On failure, prints only "<file>:<line>" for each violation, then exits 1.
 *   The offending line is never printed, so CI logs cannot re-publish a
 *   hidden payload.
 *   On success, prints a short summary and exits 0.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Maximum allowed physical line length, in characters. */
export const MAX_LINE_LENGTH = 500;

const CONFIG_FILE_PATTERN =
  /^(?:next|postcss|eslint|tailwind|vitest)\.config\.(?:[cm]?[jt]s)$/;

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.next',
  'out',
  'build',
  'dist',
  'coverage',
]);

/**
 * Whether a path is a lockfile or lives under generated/vendor output.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isIgnoredPath(path) {
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => IGNORED_DIRECTORIES.has(segment))) return true;
  return LOCKFILES.has(segments[segments.length - 1] ?? '');
}

/**
 * Whether a file name is one of the executable configuration files we guard.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isScannedConfigFile(path) {
  const name = basename(path);
  return name === 'package.json' || CONFIG_FILE_PATTERN.test(name);
}

/**
 * Find oversized physical lines in a file's contents.
 *
 * @param {string} content
 * @param {number} [maxLength]
 * @returns {{ line: number, length: number }[]}
 */
export function findOversizedLines(content, maxLength = MAX_LINE_LENGTH) {
  const violations = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const length = lines[index].length;
    if (length > maxLength) violations.push({ line: index + 1, length });
  }
  return violations;
}

/**
 * List the guarded configuration files at the root of `root`.
 *
 * @param {string} root
 * @returns {string[]} File names relative to `root`, sorted for stable output.
 */
export function findConfigFiles(root) {
  const entries = readdirSync(resolve(root), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => isScannedConfigFile(name) && !isIgnoredPath(name))
    .sort();
}

/**
 * Check a list of files relative to `root` for oversized physical lines.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {number} [maxLength]
 * @returns {{ file: string, line: number, length: number }[]}
 */
export function checkFiles(root, files, maxLength = MAX_LINE_LENGTH) {
  const violations = [];
  for (const file of files) {
    if (isIgnoredPath(file) || !isScannedConfigFile(file)) continue;
    const content = readFileSync(resolve(root, file), 'utf8');
    for (const { line, length } of findOversizedLines(content, maxLength)) {
      violations.push({ file, line, length });
    }
  }
  return violations;
}

/**
 * Find and check every guarded configuration file under `root`.
 *
 * @param {string} root
 * @param {number} [maxLength]
 * @returns {{ files: string[], violations: { file: string, line: number, length: number }[] }}
 */
export function checkRoot(root, maxLength = MAX_LINE_LENGTH) {
  const files = findConfigFiles(root);
  return { files, violations: checkFiles(root, files, maxLength) };
}

/**
 * One line per violation: only the file and line number, never the content.
 *
 * @param {{ file: string, line: number }} violation
 * @returns {string}
 */
export function formatViolation(violation) {
  return `${violation.file}:${violation.line}`;
}

function parseRoot(args) {
  const rootFlag = args.indexOf('--root');
  if (rootFlag !== -1) {
    const value = args[rootFlag + 1];
    if (value === undefined) throw new Error('--root requires a directory');
    return resolve(value);
  }
  const positional = args.find((arg) => !arg.startsWith('--'));
  return positional === undefined ? REPO_ROOT : resolve(positional);
}

function main() {
  let root;
  try {
    root = parseRoot(process.argv.slice(2));
  } catch (error) {
    console.error(
      `check-config-line-lengths: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  let result;
  try {
    result = checkRoot(root);
  } catch (error) {
    console.error(
      `check-config-line-lengths: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }

  if (result.violations.length === 0) {
    console.log(
      `check-config-line-lengths: ${result.files.length} config file(s) within ${MAX_LINE_LENGTH} characters per line.`,
    );
    return 0;
  }

  for (const violation of result.violations) console.error(formatViolation(violation));
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
