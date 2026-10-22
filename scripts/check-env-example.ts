#!/usr/bin/env tsx
/**
 * check-env-example.ts
 * ====================
 * Verifies that `.env.example` declares every environment variable at most
 * once. Duplicate keys in an example file are easy to introduce (e.g. when a
 * new section is appended) and misleading: operators may edit the wrong copy
 * or assume a later value overrides production requirements.
 *
 * Usage
 * -----
 *   npx tsx scripts/check-env-example.ts           # checks .env.example
 *   npx tsx scripts/check-env-example.ts <file>    # checks any env-style file
 *   npm run check:env-example                      # via npm script
 *   npm test                                       # covered by vitest
 *
 * Exit codes
 * ----------
 *   0  No duplicate keys found.
 *   1  One or more duplicate keys were found.
 *   2  The target file could not be read.
 *
 * Design notes
 * ------------
 * - Comment lines (`# ...`), blank lines, and commented-out examples are
 *   ignored, so guidance such as `# FOO=bar` never counts as a declaration.
 * - Both `KEY=value` and `export KEY=value` forms are recognised.
 * - Only key names and line numbers are reported — values are never printed.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EnvKeyDeclaration {
  key: string;
  line: number;
}

export interface DuplicateEnvKey {
  key: string;
  /** 1-based line numbers of every declaration, in file order. */
  lines: number[];
}

const ENV_EXAMPLE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.example");

const DECLARATION_PATTERN = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Extract every environment variable declared in an env-style file.
 *
 * A declaration is a line whose first non-whitespace character is not `#`
 * and which starts with `KEY=` (optionally prefixed by `export`).
 */
export function extractEnvDeclarations(content: string): EnvKeyDeclaration[] {
  const declarations: EnvKeyDeclaration[] = [];

  content.split(/\r?\n/).forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;

    const match = DECLARATION_PATTERN.exec(line);
    if (!match) return;

    declarations.push({ key: match[1]!, line: index + 1 });
  });

  return declarations;
}

/** Return every key that is declared more than once. */
export function findDuplicateEnvKeys(content: string): DuplicateEnvKey[] {
  const linesByKey = new Map<string, number[]>();

  for (const { key, line } of extractEnvDeclarations(content)) {
    const lines = linesByKey.get(key);
    if (lines) {
      lines.push(line);
    } else {
      linesByKey.set(key, [line]);
    }
  }

  const duplicates: DuplicateEnvKey[] = [];
  for (const [key, lines] of linesByKey) {
    if (lines.length > 1) duplicates.push({ key, lines });
  }
  return duplicates;
}

/** Render a human-readable report for the given duplicates. */
export function formatDuplicateReport(filePath: string, duplicates: DuplicateEnvKey[]): string {
  const header = `✗ ${filePath}: ${duplicates.length} duplicate environment key(s) found`;
  const details = duplicates.map(
    ({ key, lines }) => `  - ${key} declared ${lines.length} times (lines ${lines.join(", ")})`
  );
  return [header, ...details].join("\n");
}

function main(filePath: string): never {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    console.error(`Error: cannot read file — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const declarations = extractEnvDeclarations(content);
  const duplicates = findDuplicateEnvKeys(content);

  if (duplicates.length > 0) {
    console.error(formatDuplicateReport(filePath, duplicates));
    console.error("\nEach environment variable must be declared exactly once.");
    process.exit(1);
  }

  console.log(
    `✓ ${filePath}: ${declarations.length} environment keys declared, no duplicates.`
  );
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(resolve(process.argv[2] ?? ENV_EXAMPLE_PATH));
}
