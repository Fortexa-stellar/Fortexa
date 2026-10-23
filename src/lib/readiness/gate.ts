/**
 * Unified readiness gate.
 *
 * "Ready" only when ALL of these agree:
 *   - migration:    the applied database migration id is the expected one
 *   - policy_store: the policy store loads (and is not empty)
 *   - network:      the configured Stellar passphrase is the one this
 *                   deployment expects
 *
 * Every dependency is injected so tests can stub each one. The result only
 * contains check names and pass/fail, never secrets or account ids.
 */

export type ReadinessCheckName = "migration" | "policy_store" | "network";

export type ReadinessResult = {
  ready: boolean;
  /** Names of the checks that failed (empty when ready). */
  failing: ReadinessCheckName[];
  checks: Record<ReadinessCheckName, "pass" | "fail">;
};

export type ReadinessDeps = {
  /** Migration id currently applied to the database (null if none). */
  getAppliedMigrationId: () => Promise<string | null>;
  /** Migration id this build expects. */
  expectedMigrationId: string;
  /** Resolves true when the policy store loaded and has policies. */
  loadPolicyStore: () => Promise<boolean>;
  /** Passphrase the running deployment is configured with. */
  getConfiguredPassphrase: () => string | null;
  /** Passphrase this deployment is supposed to use. */
  expectedPassphrase: string | null;
};

async function safely(check: () => Promise<boolean> | boolean): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const [migration, policyStore, network] = await Promise.all([
    safely(async () => {
      const applied = await deps.getAppliedMigrationId();
      return applied !== null && applied === deps.expectedMigrationId;
    }),
    safely(() => deps.loadPolicyStore()),
    safely(() => {
      const configured = deps.getConfiguredPassphrase();
      return (
        configured !== null &&
        deps.expectedPassphrase !== null &&
        configured === deps.expectedPassphrase
      );
    }),
  ]);

  const checks: ReadinessResult["checks"] = {
    migration: migration ? "pass" : "fail",
    policy_store: policyStore ? "pass" : "fail",
    network: network ? "pass" : "fail",
  };

  const failing = (Object.keys(checks) as ReadinessCheckName[]).filter(
    (name) => checks[name] === "fail"
  );

  return { ready: failing.length === 0, failing, checks };
}

/** Safe JSON body for health and for blocked pay/decision requests. */
export function readinessBody(result: ReadinessResult) {
  return {
    ok: result.ready,
    ready: result.ready,
    failing: result.failing,
    checks: result.checks,
  };
}
