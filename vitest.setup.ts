import { mkdirSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

/**
 * Runs before every test file and gives each one its own file-store directory.
 *
 * Vitest runs test files in parallel, and several suites exercise the JSON file
 * store. Without isolation they all share `<cwd>/.fortexa`, so one file's policy
 * or wallet write lands in another file's test. Test files that need a specific
 * directory still win: their own `vi.hoisted` block runs after this setup and
 * reassigns `FORTEXA_STORE_DIR` before any store module is imported.
 */
const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const storeDir = path.join(tmpdir(), `fortexa-vitest-${unique}`);
mkdirSync(storeDir, { recursive: true });

process.env.FORTEXA_STORE_DIR = storeDir;

afterAll(async () => {
  await fs
    .rm(storeDir, { recursive: true, force: true })
    .catch(() => undefined);
});
