import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";

import {
  assertNoEmbeddedCredentials,
  hasEmbeddedCredentials,
  sanitizeUrl,
  validateRemoteServiceUrl,
} from "@/lib/validation/remote-urls";
import {
  getStellarHorizonUrl as getHorizonUrlFromNetwork,
} from "@/lib/stellar/network";
import {
  resolveStellarNetworkConfig,
  assertStellarNetworkConfig,
} from "@/lib/stellar/network-config";
import {
  isSharedSecurityStateEnabled,
  resetRedisClient,
} from "@/lib/security/shared-security-state";
import {
  fetchBlocklist,
  getBlocklistHealth,
  resetBlocklistCache,
} from "@/lib/security/blocklist";
import {
  checkProductionReadiness,
  formatProductionReadinessReport,
} from "@/lib/readiness/production";
import { redactString } from "@/lib/observability/redact";

describe("remote service URL validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    resetBlocklistCache();
    resetRedisClient();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetBlocklistCache();
    resetRedisClient();
  });

  describe("hasEmbeddedCredentials", () => {
    it("detects username and password embedded in URLs", () => {
      expect(
        hasEmbeddedCredentials("https://admin:secret123@horizon.stellar.org")
      ).toBe(true);
      expect(
        hasEmbeddedCredentials("redis://default:supersecret@localhost:6379")
      ).toBe(true);
      expect(
        hasEmbeddedCredentials(
          "https://threatuser:threatpass@intel.example.com/blocklist.json"
        )
      ).toBe(true);
    });

    it("detects password-only embedded in URLs", () => {
      expect(hasEmbeddedCredentials("redis://:mysecret@localhost:6379")).toBe(
        true
      );
      expect(
        hasEmbeddedCredentials("https://:onlypass@horizon.stellar.org")
      ).toBe(true);
    });

    it("detects username-only embedded in URLs", () => {
      expect(
        hasEmbeddedCredentials("https://operator@horizon.stellar.org")
      ).toBe(true);
      expect(
        hasEmbeddedCredentials("redis://onlyuser@localhost:6379")
      ).toBe(true);
    });

    it("detects URL-encoded embedded credentials", () => {
      expect(
        hasEmbeddedCredentials(
          "https://user%40company.com:pass%23123@horizon.stellar.org"
        )
      ).toBe(true);
    });

    it("returns false for clean URLs without credentials", () => {
      expect(hasEmbeddedCredentials("https://horizon.stellar.org")).toBe(false);
      expect(
        hasEmbeddedCredentials("https://horizon-testnet.stellar.org")
      ).toBe(false);
      expect(hasEmbeddedCredentials("redis://localhost:6379")).toBe(false);
      expect(hasEmbeddedCredentials("rediss://127.0.0.1:6379/0")).toBe(false);
      expect(
        hasEmbeddedCredentials("https://example.com/blocklist.json")
      ).toBe(false);
    });

    it("handles falsy and non-string inputs safely", () => {
      expect(hasEmbeddedCredentials("")).toBe(false);
      expect(hasEmbeddedCredentials(undefined)).toBe(false);
      expect(hasEmbeddedCredentials(null)).toBe(false);
      expect(hasEmbeddedCredentials("not a valid url")).toBe(false);
    });
  });

  describe("sanitizeUrl", () => {
    it("strips username and password from URLs", () => {
      const sanitized = sanitizeUrl(
        "https://admin:secret123@horizon.stellar.org:8000/fee_stats?foo=bar"
      );
      expect(sanitized).toBe("https://horizon.stellar.org:8000/fee_stats?foo=bar");
      expect(sanitized).not.toContain("admin");
      expect(sanitized).not.toContain("secret123");
    });

    it("strips password-only from Redis URL", () => {
      const sanitized = sanitizeUrl("redis://:secret@localhost:6379/1");
      expect(sanitized).toBe("redis://localhost:6379/1");
      expect(sanitized).not.toContain("secret");
    });

    it("preserves clean URLs unchanged", () => {
      expect(sanitizeUrl("https://horizon.stellar.org/")).toBe(
        "https://horizon.stellar.org/"
      );
    });
  });

  describe("validateRemoteServiceUrl", () => {
    it("returns ok for clean service URLs", () => {
      const result = validateRemoteServiceUrl(
        "https://horizon.stellar.org",
        "STELLAR_HORIZON_URL"
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.url).toBe("https://horizon.stellar.org");
      }
    });

    it("rejects credential-bearing URLs without leaking credentials", () => {
      const username = "customoperator";
      const secretPass = "super_classified_secret_999";
      const result = validateRemoteServiceUrl(
        `https://${username}:${secretPass}@horizon.stellar.org`,
        "STELLAR_HORIZON_URL"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(
          "STELLAR_HORIZON_URL must not contain embedded username or password credentials"
        );
        expect(result.error).not.toContain(secretPass);
        expect(result.error).not.toContain(username);
      }
    });

    it("rejects unconfigured or empty URLs", () => {
      const result = validateRemoteServiceUrl("", "REDIS_URL");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("REDIS_URL is not configured");
      }
    });
  });

  describe("assertNoEmbeddedCredentials", () => {
    it("throws when credentials are present without leaking them", () => {
      const username = "customoperator";
      const secretPass = "vault_password_abc_123";
      expect(() =>
        assertNoEmbeddedCredentials(
          `https://${username}:${secretPass}@horizon.stellar.org`,
          "STELLAR_HORIZON_URL"
        )
      ).toThrowError(/STELLAR_HORIZON_URL must not contain embedded username or password credentials/);

      try {
        assertNoEmbeddedCredentials(
          `https://${username}:${secretPass}@horizon.stellar.org`,
          "STELLAR_HORIZON_URL"
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).not.toContain(secretPass);
        expect(message).not.toContain(username);
      }
    });

    it("does not throw for valid clean URLs or undefined", () => {
      expect(() =>
        assertNoEmbeddedCredentials("https://horizon.stellar.org", "STELLAR_HORIZON_URL")
      ).not.toThrow();
      expect(() =>
        assertNoEmbeddedCredentials(undefined, "STELLAR_HORIZON_URL")
      ).not.toThrow();
    });
  });

  describe("Stellar Horizon integration", () => {
    it("rejects credential-bearing Horizon URL in getStellarHorizonUrl", () => {
      const secret = "horizon_leak_attempt_pass";
      expect(() =>
        getHorizonUrlFromNetwork({
          STELLAR_HORIZON_URL: `https://user:${secret}@horizon.stellar.org`,
        })
      ).toThrowError(/STELLAR_HORIZON_URL must not contain embedded username or password credentials/);
    });

    it("rejects credential-bearing Horizon URL in resolveStellarNetworkConfig without leaking credentials", () => {
      const secret = "classified_horizon_credential";
      process.env.STELLAR_HORIZON_URL = `https://user:${secret}@horizon.stellar.org`;
      process.env.STELLAR_NETWORK_PASSPHRASE = Networks.PUBLIC;

      const config = resolveStellarNetworkConfig();
      expect(config.ok).toBe(false);
      if (!config.ok) {
        expect(config.error).toContain("STELLAR_HORIZON_URL must not contain embedded username or password credentials");
        expect(config.error).not.toContain(secret);
      }

      expect(() => assertStellarNetworkConfig()).toThrowError(
        /STELLAR_HORIZON_URL must not contain embedded username or password credentials/
      );
    });
  });

  describe("Redis integration", () => {
    it("refuses to enable Redis shared security state when REDIS_URL has credentials", () => {
      const secret = "redis_auth_pass_777";
      process.env.REDIS_URL = `redis://default:${secret}@localhost:6379`;
      delete process.env.FORTEXA_SHARED_STATE_PATH;

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(isSharedSecurityStateEnabled()).toBe(false);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("supports separate REDIS_PASSWORD and REDIS_USERNAME options", () => {
      process.env.REDIS_URL = "redis://localhost:6379";
      process.env.REDIS_PASSWORD = "safe-redis-password";
      process.env.REDIS_USERNAME = "default";
      delete process.env.FORTEXA_SHARED_STATE_PATH;

      expect(isSharedSecurityStateEnabled()).toBe(true);
    });
  });

  describe("Blocklist integration", () => {
    it("rejects fetching blocklist with embedded credentials before network call", async () => {
      const secret = "blocklist_secret_key_888";
      process.env.FORTEXA_BLOCKLIST_URL = `https://admin:${secret}@intel.example.com/blocklist.json`;

      const fetchSpy = vi.spyOn(globalThis, "fetch");

      await expect(fetchBlocklist()).rejects.toThrowError(
        /FORTEXA_BLOCKLIST_URL must not contain embedded username or password credentials/
      );

      // Verify no network request was dispatched with credentials
      expect(fetchSpy).not.toHaveBeenCalled();

      const health = getBlocklistHealth();
      expect(health.configured).toBe(false);
      expect(health.lastError).toContain("FORTEXA_BLOCKLIST_URL contains embedded credentials");
      expect(health.lastError).not.toContain(secret);
    });
  });

  describe("Production readiness check integration", () => {
    it("flags credential-bearing remote service URLs as issues without leaking credentials", () => {
      const horizonSecret = "leak_horizon_pw";
      const redisSecret = "leak_redis_pw";
      const blocklistSecret = "leak_blocklist_pw";

      const report = checkProductionReadiness({
        NODE_ENV: "production",
        STELLAR_HORIZON_URL: `https://user:${horizonSecret}@horizon.stellar.org`,
        STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
        FORTEXA_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
        FORTEXA_OPERATOR_WALLETS: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
        REDIS_URL: `redis://user:${redisSecret}@redis.prod.internal:6379`,
        FORTEXA_BLOCKLIST_URL: `https://admin:${blocklistSecret}@blocklist.internal/domains.txt`,
        DATABASE_URL: "postgres://fortexa:secret@db.example.com:5432/fortexa",
      });

      expect(report.ok).toBe(false);

      const formatted = formatProductionReadinessReport(report);
      expect(formatted).not.toContain(horizonSecret);
      expect(formatted).not.toContain(redisSecret);
      expect(formatted).not.toContain(blocklistSecret);

      const issueSettings = report.issues.map((i) => i.setting);
      expect(issueSettings).toContain("STELLAR_HORIZON_URL");
      expect(issueSettings).toContain("REDIS_URL");
      expect(issueSettings).toContain("FORTEXA_BLOCKLIST_URL");
    });
  });

  describe("Observability redaction defense-in-depth", () => {
    it("redacts credentials from error strings containing remote service URLs", () => {
      const logLine1 = "Failed to connect to redis://admin:topsecret@redis.internal:6379/0";
      expect(redactString(logLine1)).toBe(
        "Failed to connect to redis://[REDACTED]@redis.internal:6379/0"
      );

      const logLine2 = "Error fetching https://intel_user:token99@feed.example.com/data";
      expect(redactString(logLine2)).toBe(
        "Error fetching https://[REDACTED]@feed.example.com/data"
      );

      const logLine3 = "Horizon error at https://user:pass@horizon.stellar.org/accounts";
      expect(redactString(logLine3)).toBe(
        "Horizon error at https://[REDACTED]@horizon.stellar.org/accounts"
      );
    });
  });
});
