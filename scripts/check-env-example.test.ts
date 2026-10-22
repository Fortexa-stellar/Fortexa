import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  extractEnvDeclarations,
  findDuplicateEnvKeys,
  formatDuplicateReport,
} from "./check-env-example";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE = resolve(__dirname, "..", ".env.example");

describe("extractEnvDeclarations", () => {
  it("returns each declared key with its 1-based line number", () => {
    const content = ["# comment", "", "FOO=1", "BAR=2"].join("\n");
    expect(extractEnvDeclarations(content)).toEqual([
      { key: "FOO", line: 3 },
      { key: "BAR", line: 4 },
    ]);
  });

  it("ignores comment lines, including commented-out examples", () => {
    const content = ["# FOO=1", "#   BAR=2", "   # BAZ=3"].join("\n");
    expect(extractEnvDeclarations(content)).toEqual([]);
  });

  it("accepts the export prefix and surrounding whitespace", () => {
    const content = ["  export FOO=1", "BAR = 2"].join("\n");
    expect(extractEnvDeclarations(content)).toEqual([
      { key: "FOO", line: 1 },
      { key: "BAR", line: 2 },
    ]);
  });

  it("does not treat values containing '=' as new declarations", () => {
    const content = "DATABASE_URL=postgres://user:pass@host/db?sslmode=require";
    expect(extractEnvDeclarations(content)).toEqual([{ key: "DATABASE_URL", line: 1 }]);
  });
});

describe("findDuplicateEnvKeys", () => {
  it("reports a repeated key with every declaration line", () => {
    const content = ["FOO=1", "BAR=2", "FOO=3"].join("\n");
    expect(findDuplicateEnvKeys(content)).toEqual([{ key: "FOO", lines: [1, 3] }]);
  });

  it("returns no duplicates when every key is unique", () => {
    const content = ["FOO=1", "# FOO=2", "BAR=2"].join("\n");
    expect(findDuplicateEnvKeys(content)).toEqual([]);
  });

  it("reports multiple duplicated keys separately", () => {
    const content = ["FOO=1", "BAR=2", "FOO=3", "BAR=4"].join("\n");
    expect(findDuplicateEnvKeys(content)).toEqual([
      { key: "FOO", lines: [1, 3] },
      { key: "BAR", lines: [2, 4] },
    ]);
  });

  it("does not include values in the report", () => {
    const content = ["SECRET=hunter2", "SECRET=hunter2"].join("\n");
    const report = formatDuplicateReport(".env.example", findDuplicateEnvKeys(content));
    expect(report).toContain("SECRET");
    expect(report).not.toContain("hunter2");
  });
});

describe(".env.example", () => {
  const content = readFileSync(ENV_EXAMPLE, "utf8");

  it("declares every environment variable exactly once", () => {
    const duplicates = findDuplicateEnvKeys(content);
    expect(duplicates, formatDuplicateReport(".env.example", duplicates)).toEqual([]);
  });

  it("still declares the required keys", () => {
    const keys = new Set(extractEnvDeclarations(content).map(({ key }) => key));
    for (const key of [
      "STELLAR_HORIZON_URL",
      "STELLAR_NETWORK_PASSPHRASE",
      "DATABASE_URL",
      "DATABASE_SSL",
      "FORTEXA_STORE_DIR",
      "FORTEXA_SHARED_STATE_PATH",
      "REDIS_URL",
      "FORTEXA_AUTH_SECRET",
      "FORTEXA_OPERATOR_WALLETS",
      "FORTEXA_SIGNER_WALLETS",
      "FORTEXA_VIEWER_WALLETS",
      "FORTEXA_AUTH_CHALLENGE_TTL_SECONDS",
      "FORTEXA_AUTH_MAX_ATTEMPTS",
      "FORTEXA_AUTH_LOCK_MINUTES",
      "GROQ_API_KEY",
      "GROQ_MODEL",
      "FORTEXA_BLOCKLIST_URL",
      "FORTEXA_IDEMPOTENCY_RETENTION_DAYS",
      "FORTEXA_IDEMPOTENCY_IN_FLIGHT_WAIT_MS",
      "FORTEXA_JSON_BODY_MAX_BYTES",
      "FORTEXA_ALLOW_LOCAL_RESET",
      "NEXT_PUBLIC_STELLAR_DESTINATION",
    ]) {
      expect(keys.has(key), `missing key: ${key}`).toBe(true);
    }
  });
});
