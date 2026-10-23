import { describe, expect, it } from "vitest";

import { checkReadiness, readinessBody, type ReadinessDeps } from "./gate";

const PUBLIC = "Public Global Stellar Network ; September 2015";
const TESTNET = "Test SDF Network ; September 2015";

function deps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    getAppliedMigrationId: async () => "0003_latest",
    expectedMigrationId: "0003_latest",
    loadPolicyStore: async () => true,
    getConfiguredPassphrase: () => PUBLIC,
    expectedPassphrase: PUBLIC,
    ...overrides,
  };
}

describe("checkReadiness", () => {
  it("is ready when migration, policy store and network all pass", async () => {
    const result = await checkReadiness(deps());
    expect(result.ready).toBe(true);
    expect(result.failing).toEqual([]);
    expect(result.checks).toEqual({
      migration: "pass",
      policy_store: "pass",
      network: "pass",
    });
  });

  it("is not ready and names the migration check for a stale migration", async () => {
    const result = await checkReadiness(deps({ getAppliedMigrationId: async () => "0002_older" }));
    expect(result.ready).toBe(false);
    expect(result.failing).toEqual(["migration"]);
  });

  it("fails the migration check when no migration is applied", async () => {
    const result = await checkReadiness(deps({ getAppliedMigrationId: async () => null }));
    expect(result.failing).toEqual(["migration"]);
  });

  it("fails the migration check when reading it throws", async () => {
    const result = await checkReadiness(
      deps({
        getAppliedMigrationId: async () => {
          throw new Error("db down");
        },
      })
    );
    expect(result.ready).toBe(false);
    expect(result.failing).toEqual(["migration"]);
  });

  it("is not ready when the policy store is empty or unavailable", async () => {
    const empty = await checkReadiness(deps({ loadPolicyStore: async () => false }));
    expect(empty.failing).toEqual(["policy_store"]);

    const broken = await checkReadiness(
      deps({
        loadPolicyStore: async () => {
          throw new Error("cannot read");
        },
      })
    );
    expect(broken.failing).toEqual(["policy_store"]);
  });

  it("is not ready on a passphrase mismatch", async () => {
    const result = await checkReadiness(deps({ getConfiguredPassphrase: () => TESTNET }));
    expect(result.ready).toBe(false);
    expect(result.failing).toEqual(["network"]);
  });

  it("is not ready when the passphrase is missing", async () => {
    const result = await checkReadiness(deps({ getConfiguredPassphrase: () => null }));
    expect(result.failing).toEqual(["network"]);
  });

  it("reports every failing check", async () => {
    const result = await checkReadiness(
      deps({
        getAppliedMigrationId: async () => null,
        loadPolicyStore: async () => false,
        getConfiguredPassphrase: () => TESTNET,
      })
    );
    expect(result.failing).toEqual(["migration", "policy_store", "network"]);
  });
});

describe("readinessBody", () => {
  it("contains only check names and pass/fail, never passphrases or ids", async () => {
    const result = await checkReadiness(deps({ getConfiguredPassphrase: () => TESTNET }));
    const serialized = JSON.stringify(readinessBody(result));

    expect(Object.keys(readinessBody(result)).sort()).toEqual(
      ["checks", "failing", "ok", "ready"].sort()
    );
    expect(serialized).not.toContain(TESTNET);
    expect(serialized).not.toContain(PUBLIC);
    expect(serialized).not.toContain("0003_latest");
  });
});
