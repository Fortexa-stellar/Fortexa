import { Networks } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import {
  checkProductionReadiness,
  evaluateServiceReadiness,
  formatProductionReadinessReport,
  getProtectedPaymentFlowReadinessReport,
} from "@/lib/readiness/production";

const VALID_OPERATOR_WALLET =
  "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";

describe("production readiness", () => {
  it("passes for a valid production configuration", () => {
    const report = checkProductionReadiness(
      {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_BLOCKLIST_URL: "https://blocklist.example.com/list.json",
        FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
        FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa" }
    );

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("reports missing required production variables", () => {
    const report = checkProductionReadiness({ NODE_ENV: "test" }, { cwd: "/srv/fortexa" });

    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.setting)).toEqual(
      expect.arrayContaining([
        "STELLAR_HORIZON_URL",
        "STELLAR_NETWORK_PASSPHRASE",
        "FORTEXA_BLOCKLIST_URL",
        "FORTEXA_AUTH_SECRET",
        "FORTEXA_OPERATOR_WALLETS",
        "DATABASE_URL or FORTEXA_STORE_DIR",
        "REDIS_URL or FORTEXA_SHARED_STATE_PATH",
      ])
    );
  });

  it("rejects the wrong Stellar network passphrase for production", () => {
    const report = checkProductionReadiness(
      {
        NODE_ENV: "test",
        DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
        FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa" }
    );

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          setting: "STELLAR_NETWORK_PASSPHRASE",
        }),
      ])
    );
  });

  it("rejects missing storage backend configuration", () => {
    const report = checkProductionReadiness(
      {
        NODE_ENV: "test",
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
        FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa" }
    );

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          setting: "DATABASE_URL or FORTEXA_STORE_DIR",
          message: expect.stringContaining("persistent storage backend"),
        }),
      ])
    );
  });

  it("rejects unsafe demo defaults for Horizon and file storage", () => {
    const report = checkProductionReadiness(
      {
        NODE_ENV: "test",
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
        FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
        FORTEXA_STORE_DIR: ".fortexa",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa" }
    );

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          setting: "STELLAR_HORIZON_URL",
          message: expect.stringContaining("Testnet Horizon"),
        }),
        expect.objectContaining({
          setting: "FORTEXA_STORE_DIR",
          message: expect.stringContaining("demo default"),
        }),
        expect.objectContaining({
          setting: "STELLAR_HORIZON_URL, STELLAR_NETWORK_PASSPHRASE",
        }),
      ])
    );
  });

  it("formats actionable output without exposing secret values", () => {
    const report = checkProductionReadiness(
      {
        NODE_ENV: "test",
        FORTEXA_AUTH_SECRET: "too-short-secret",
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa" }
    );

    const formatted = formatProductionReadinessReport(report);

    expect(formatted).toContain("FORTEXA_AUTH_SECRET");
    expect(formatted).not.toContain("too-short-secret");
  });

  it("only enforces payment-flow readiness in production", () => {
    const report = getProtectedPaymentFlowReadinessReport({
      NODE_ENV: "development",
    });

    expect(report).toBeNull();
  });

  it("passes for a consistent production fixture", () => {
    const report = checkProductionReadiness({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_BLOCKLIST_URL: "https://blocklist.example.com/list.json",
        FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
        FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa", appliedMigrationId: "005_audit_chain_sequence" }
    );

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("rejects testnet passphrase in production mode", () => {
    const report = checkProductionReadiness({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
        FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa", appliedMigrationId: "006_audit_chain_sequence" }
    );

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          setting: "NODE_ENV, STELLAR_NETWORK_PASSPHRASE",
        }),
      ])
    );
  });

  it("rejects stale migration in production mode", () => {
    const report = checkProductionReadiness({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
        FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
      } as unknown as NodeJS.ProcessEnv,
      { cwd: "/srv/fortexa", appliedMigrationId: "001_initial_storage" }
    );

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          setting: "NODE_ENV, fortexa_schema_migrations",
        }),
      ])
    );
  });

  const validProductionEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
    FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    FORTEXA_BLOCKLIST_URL: "https://blocklist.example.com/list.json",
    FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
    FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
    STELLAR_HORIZON_URL: "https://horizon.stellar.org",
    STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
  } as unknown as NodeJS.ProcessEnv;

  it("accepts an HTTPS blocklist URL in production", () => {
    const report = checkProductionReadiness(validProductionEnv, { cwd: "/srv/fortexa" });

    expect(report.issues.map((issue) => issue.setting)).not.toContain("FORTEXA_BLOCKLIST_URL");
  });

  it.each([
    ["", "required in production"],
    ["   ", "required in production"],
    ["http://blocklist.example.com/list.json", "must use HTTPS"],
    ["not a url", "valid HTTPS URL"],
    ["https://", "valid HTTPS URL"],
  ])("rejects blocklist URL %j in production (%s)", (blocklistUrl, message) => {
    const report = checkProductionReadiness(
      { ...validProductionEnv, FORTEXA_BLOCKLIST_URL: blocklistUrl },
      { cwd: "/srv/fortexa" }
    );

    expect(report.ok).toBe(false);
    const issue = report.issues.find((entry) => entry.setting === "FORTEXA_BLOCKLIST_URL");
    expect(issue?.message).toEqual(expect.stringContaining(message));
    if (blocklistUrl.trim()) {
      expect(issue?.message).not.toContain(blocklistUrl.trim());
    }
  });
});

describe("service readiness", () => {
  const productionEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
    FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    FORTEXA_BLOCKLIST_URL: "https://blocklist.example.com/list.json",
    FORTEXA_OPERATOR_WALLETS: VALID_OPERATOR_WALLET,
    FORTEXA_SHARED_STATE_PATH: "shared/security-state.json",
    STELLAR_HORIZON_URL: "https://horizon.stellar.org",
    STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
  } as NodeJS.ProcessEnv;

  it("is ready when config, the configured database, and Horizon all pass", () => {
    const readiness = evaluateServiceReadiness({
      env: productionEnv,
      cwd: "/srv/fortexa",
      databaseAvailable: true,
      horizonStatus: "healthy",
    });

    expect(readiness).toEqual({
      ready: true,
      checks: [
        { name: "production_config", ok: true },
        { name: "storage", ok: true },
        { name: "horizon", ok: true },
      ],
      failingChecks: [],
    });
  });

  it("fails production_config exactly when the payment routes would refuse", () => {
    const unsafeEnv = { ...productionEnv, STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET } as NodeJS.ProcessEnv;

    expect(getProtectedPaymentFlowReadinessReport(unsafeEnv, { cwd: "/srv/fortexa" })).not.toBeNull();
    expect(
      evaluateServiceReadiness({ env: unsafeEnv, cwd: "/srv/fortexa", databaseAvailable: true, horizonStatus: "healthy" })
        .failingChecks
    ).toEqual(["production_config"]);

    // Outside production the payment routes do not enforce config, so neither does readiness.
    const devEnv = { ...unsafeEnv, NODE_ENV: "development" } as NodeJS.ProcessEnv;
    expect(getProtectedPaymentFlowReadinessReport(devEnv)).toBeNull();
    expect(evaluateServiceReadiness({ env: devEnv, databaseAvailable: true, horizonStatus: "healthy" }).ready).toBe(
      true
    );
  });

  it("fails storage only when a configured database does not answer", () => {
    const down = evaluateServiceReadiness({
      env: { NODE_ENV: "test", DATABASE_URL: "postgres://db" } as NodeJS.ProcessEnv,
      databaseAvailable: false,
      horizonStatus: "unknown",
    });
    expect(down.failingChecks).toEqual(["storage"]);

    const fileStore = evaluateServiceReadiness({
      env: { NODE_ENV: "test" } as NodeJS.ProcessEnv,
      databaseAvailable: false,
      horizonStatus: "unknown",
    });
    expect(fileStore.ready).toBe(true);
  });

  it("fails horizon only when a configured Horizon is degraded", () => {
    const env = { NODE_ENV: "test" } as NodeJS.ProcessEnv;

    expect(
      evaluateServiceReadiness({ env, databaseAvailable: false, horizonStatus: "degraded" }).failingChecks
    ).toEqual(["horizon"]);
    expect(evaluateServiceReadiness({ env, databaseAvailable: false, horizonStatus: "unknown" }).ready).toBe(true);
  });
});
