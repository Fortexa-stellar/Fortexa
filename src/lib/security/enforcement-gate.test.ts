import { rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { resetBlocklistCache } from "@/lib/security/blocklist";
import {
  enforceRequestGate,
  extractDestinationDomain,
} from "@/lib/security/enforcement-gate";
import { resetRateLimitStore } from "@/lib/security/rate-limit";

const sharedStatePath = path.join(
  process.cwd(),
  ".fortexa",
  "enforcement-gate-shared.test.json",
);

function requestFromIp(ip: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/decision", {
    method: "POST",
    headers: {
      "x-forwarded-for": ip,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("extractDestinationDomain", () => {
  it("extracts the host from URL-style targets", () => {
    expect(extractDestinationDomain("https://api.gateway.com/pay")).toBe(
      "api.gateway.com",
    );
    expect(extractDestinationDomain("http://Evil.Example.ORG/path")).toBe(
      "evil.example.org",
    );
  });

  it("extracts the domain from SEP-2 federated addresses", () => {
    expect(extractDestinationDomain("alice*stellar.example.com")).toBe(
      "stellar.example.com",
    );
  });

  it("returns bare domains unchanged (lowercased)", () => {
    expect(extractDestinationDomain("  BadActor.COM ")).toBe("badactor.com");
  });

  it("strips a port suffix", () => {
    expect(extractDestinationDomain("https://host.example.com:8080/x")).toBe(
      "host.example.com",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(extractDestinationDomain("")).toBe("");
    expect(extractDestinationDomain("   ")).toBe("");
  });
});

describe("enforceRequestGate", () => {
  beforeEach(() => {
    delete process.env.FORTEXA_BLOCKLIST_URL;
    delete process.env.FORTEXA_SHARED_STATE_PATH;
    delete process.env.REDIS_URL;
    resetBlocklistCache();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    delete process.env.FORTEXA_BLOCKLIST_URL;
    delete process.env.FORTEXA_SHARED_STATE_PATH;
    await rm(sharedStatePath, { force: true });
    resetBlocklistCache();
    await resetRateLimitStore();
  });

  it("allows a clean request and reports the rate budget", async () => {
    const result = await enforceRequestGate(requestFromIp("10.9.0.1"), {
      rateLimitKey: "gate-test",
      limit: 5,
      windowMs: 60_000,
      destination: "https://trusted.example.com/pay",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rate.ok).toBe(true);
      expect(result.rate.remaining).toBe(4);
    }
  });

  it("rejects an HTTP blocklist URL in production instead of failing open", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FORTEXA_BLOCKLIST_URL", "http://example.com/blocklist.json");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      await expect(
        enforceRequestGate(requestFromIp("10.9.0.2"), {
          rateLimitKey: "gate-https",
          limit: 5,
          windowMs: 60_000,
          destination: "https://trusted.example.com/pay",
        })
      ).rejects.toThrow("must use HTTPS");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });

  it("denies a blocklisted destination with code BLOCKLISTED and 403", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad-actor.com"]), { status: 200 }),
    );

    const result = await enforceRequestGate(requestFromIp("10.9.0.2"), {
      rateLimitKey: "gate-test",
      limit: 5,
      windowMs: 60_000,
      destination: "https://bad-actor.com/pay",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("BLOCKLISTED");
      expect(result.status).toBe(403);
      // Rate budget was still consumed for this request
      expect(result.rate?.ok).toBe(true);
    }
  });

  it("denies with RATE_LIMITED and 429 once the budget is exhausted", async () => {
    const ip = "10.9.0.3";
    for (let i = 0; i < 3; i += 1) {
      const allowed = await enforceRequestGate(requestFromIp(ip), {
        rateLimitKey: "gate-limit-test",
        limit: 3,
        windowMs: 60_000,
      });
      expect(allowed.ok).toBe(true);
    }

    const denied = await enforceRequestGate(requestFromIp(ip), {
      rateLimitKey: "gate-limit-test",
      limit: 3,
      windowMs: 60_000,
    });

    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe("RATE_LIMITED");
      expect(denied.status).toBe(429);
      expect(denied.rate?.ok).toBe(false);
      expect(denied.rate?.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("keeps the limit exact under concurrent requests via shared state", async () => {
    process.env.FORTEXA_SHARED_STATE_PATH = sharedStatePath;

    const limit = 5;
    const total = 24;
    const requests = Array.from({ length: total }, () =>
      enforceRequestGate(requestFromIp("10.9.0.4"), {
        rateLimitKey: "gate-concurrent-test",
        limit,
        windowMs: 60_000,
      }),
    );

    const results = await Promise.all(requests);
    const allowed = results.filter((r) => r.ok);
    const denied = results.filter((r) => !r.ok);

    expect(allowed).toHaveLength(limit);
    expect(denied).toHaveLength(total - limit);
    for (const deniedResult of denied) {
      if (!deniedResult.ok) {
        expect(deniedResult.code).toBe("RATE_LIMITED");
      }
    }
  });

  it("applies the same verdict to different route keys for one destination", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(["shared-bad.com"]), { status: 200 }),
    );

    for (const key of ["decision", "stellar-build-payment", "stellar-submit-signed"]) {
      const result = await enforceRequestGate(requestFromIp("10.9.0.5"), {
        rateLimitKey: key,
        limit: 5,
        windowMs: 60_000,
        destination: "shared-bad.com",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("BLOCKLISTED");
      }
    }
  });

  it("degrades open when the feed is unavailable", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const result = await enforceRequestGate(requestFromIp("10.9.0.6"), {
      rateLimitKey: "gate-test",
      limit: 5,
      windowMs: 60_000,
      destination: "some-domain.com",
    });

    expect(result.ok).toBe(true);
  });

  it("skips the blocklist check when no destination is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await enforceRequestGate(requestFromIp("10.9.0.7"), {
      rateLimitKey: "gate-test",
      limit: 5,
      windowMs: 60_000,
    });

    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves the cached feed without re-fetching on every request", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(["cache-gated.com"]), { status: 200 }),
      );

    await enforceRequestGate(requestFromIp("10.9.0.8"), {
      rateLimitKey: "gate-cache-test",
      limit: 10,
      windowMs: 60_000,
      destination: "cache-gated.com",
    });

    const second = await enforceRequestGate(requestFromIp("10.9.0.8"), {
      rateLimitKey: "gate-cache-test-2",
      limit: 10,
      windowMs: 60_000,
      destination: "cache-gated.com",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(false);
  });
});
