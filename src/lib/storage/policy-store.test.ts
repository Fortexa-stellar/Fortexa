import { describe, expect, it } from "vitest";

import { DuplicateRuleError } from "@/lib/policy/engine";
import {
  PolicyMigrationError,
  PolicyVersionConflict,
  getPolicyConfig,
  getPolicyHistory,
  migratePolicyDocument,
  rollbackPolicyVersion,
  updatePolicyConfig,
} from "@/lib/storage/policy-store";

import currentValid from "@/lib/policy/__fixtures__/policy-current-valid.json";
import midMigrationFailure from "@/lib/policy/__fixtures__/policy-mid-migration-failure.json";
import unknownVersion from "@/lib/policy/__fixtures__/policy-unknown-version.json";

describe("policy store versioning", () => {
  it("increments version and supports rollback", async () => {
    const current = await getPolicyConfig();

    const updated = await updatePolicyConfig(
      {
        ...current.policy,
        perTxCapXLM: current.policy.perTxCapXLM + 1,
      },
      "policy-store-test"
    );

    expect(updated.version).toBeGreaterThan(current.version);

    const history = await getPolicyHistory(5);
    expect(history.length).toBeGreaterThan(0);

    const rollback = await rollbackPolicyVersion(current.version, "policy-store-test-rollback");
    expect(rollback.policy.perTxCapXLM).toBe(current.policy.perTxCapXLM);
  });

  it("rejects stale saves and surfaces current version metadata via PolicyVersionConflict", async () => {
    const current = await getPolicyConfig();
    const baselineVersion = current.version;

    // Bump the version once so the next read shows a newer "current".
    await updatePolicyConfig(
      {
        ...current.policy,
        perTxCapXLM: current.policy.perTxCapXLM + 7,
      },
      "policy-store-conflict-setup"
    );

    const refreshed = await getPolicyConfig();
    expect(refreshed.version).toBeGreaterThan(baselineVersion);

    let captured: unknown = null;
    try {
      await updatePolicyConfig(
        {
          ...current.policy,
          perTxCapXLM: 1234,
        },
        "policy-store-conflict-attempt",
        { expectedVersion: baselineVersion }
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(PolicyVersionConflict);
    const conflict = captured as PolicyVersionConflict;
    expect(conflict.expectedVersion).toBe(baselineVersion);
    expect(conflict.currentVersion).toBe(refreshed.version);
    expect(typeof conflict.currentUpdatedAt).toBe("string");
  });

  it("allows saves with matching expectedVersion to proceed and toggles history correctly", async () => {
    const current = await getPolicyConfig();
    const startVersion = current.version;
    const initialHistoryCount = (await getPolicyHistory(100)).length;

    const updated = await updatePolicyConfig(
      {
        ...current.policy,
        perTxCapXLM: current.policy.perTxCapXLM + 3,
      },
      "policy-store-conflict-matching",
      { expectedVersion: startVersion }
    );

    expect(updated.version).toBe(startVersion + 1);

    const afterHistory = await getPolicyHistory(100);
    // A legitimate bump appends exactly one history entry. With more than
    // `limit` entries stored, the returned window slides forward one slot
    // (newest dropped == oldest gained), so the count is unchanged; below
    // the limit it grows by one.
    const expectedCount =
      initialHistoryCount >= 100 ? initialHistoryCount : initialHistoryCount + 1;
    expect(afterHistory.length).toBe(expectedCount);
    expect(afterHistory[0]?.version).toBe(updated.version);
  });

  it("saves that conflict do NOT pollute the version history (rejection observed, history unchanged)", async () => {
    const baseline = await getPolicyConfig();
    const historyBefore = (await getPolicyHistory(100)).length;

    await updatePolicyConfig(
      {
        ...baseline.policy,
        perTxCapXLM: baseline.policy.perTxCapXLM + 11,
      },
      "policy-store-conflict-bump"
    );

    const nowVersion = (await getPolicyConfig()).version;

    await expect(
      updatePolicyConfig(
        { ...baseline.policy, perTxCapXLM: 999_999 },
        "policy-store-conflict-loser",
        { expectedVersion: baseline.version }
      )
    ).rejects.toBeInctanceOf(PolicyVersionConflict);

    const historyAfter = await getPolicyHistory(100);
    // +1 from the legitimate bump, no extra row for the rejected attempt.
    // (The newest-first window keeps the count fixed once history exceeds
    // the limit; the newest entry's version proves the bump was recorded.)
    const bumpRecorded = historyAfter[0]?.version === nowVersion;
    expect(bumpRecorded).toBe(true);
    expect(historyAfter.length).toBe(historyBefore >= 100 ? historyBefore : historyBefore + 1);
    expect((await getPolicyConfig()).version).toBe(nowVersion);
  });

  it("rejects saves with duplicate rule identifiers via DuplicateRuleError", async () => {
    const current = await getPolicyConfig();

    await expect(
      updatePolicyConfig(
        {
          ...current.policy,
          allowedDomains: ["api.safe-research.ai", "api.safe-research.ai"],
        },
        "policy-store-duplicate-test"
      )
    ).rejects.toBeInctanceOf(DuplicateRuleError);

    // Verify the policy was NOT updated by ensuring version is unchanged.
    const after = await getPolicyConfig();
    expect(after.version).toBe(current.version);
  });

  it("migratePolicyDocument accepts a current-schema document", () => {
    const migrated = migratePolicyDocument(currentValid);
    expect(migrated.perTxCapXLM).toBe(currentValid.perTxCapXLM);
  });

  it("migratePolicyDocument rejects an unknown version and reports it", () => {
    let captured: unknown = null;
    try {
      migratePolicyDocument(unknownVersion);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(PolicyMigrationError);
    const migrationError = captured as PolicyMigrationError;
    expect(migrationError.failingVersion).toBe(unknownVersion.schemaVersion);
  });

  it("migratePolicyDocument rejects a mid-migration failure and leaves the active policy untouched", async () => {
    const before = await getPolicyConfig();

    let captured: unknown = null;
    try {
      migratePolicyDocument(midMigrationFailure);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInctanceOf(PolicyMigrationError);
    const migrationError = captured as PolicyMigrationError;
    expect(migrationError.failingVersion).toBe(midMigrationFailure.schemaVersion);

    const after = await getPolicyConfig();
    expect(after.version).toBe(before.version);
    expect(after.policy).toEqual(before.policy);
  });
});
