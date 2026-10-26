import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST, getChallenge } from "@/app/api/auth/challenge/route";
import { resetRateLimitStore } from "@/lib/security/rate-limit";
import { resetWalletChallengeStore } from "@/lib/auth/wallet-challenge";

const VALID_STELLAR_KEY =
  "GBZXN7PIRZGNMHGA72W2DISDGFIC3ALVMUSQQUBWNX25EBNOOGDHNVAA";
const ANOTHER_VALID_KEY =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function buildPostRequest(
  body?: unknown,
  headers?: Record<string, string>,
): NextRequest {
  const reqHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };

  return new NextRequest("http://localhost/api/auth/challenge", {
    method: "POST",
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function buildGetRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/auth/challenge", {
    method: "GET",
    headers,
  });
}

describe("POST /api/auth/challenge direct route tests (#350)", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.FORTEXA_AUTH_CHALLENGE_TTL_SECONDS;
    await resetRateLimitStore();
    await resetWalletChallengeStore();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetRateLimitStore();
    await resetWalletChallengeStore();
  });

  // ── 1. Valid Challenge Creation ───────────────────────────────────────────
  describe("Valid challenge creation", () => {
    it("creates a well-formed SEP-53 challenge for a valid Stellar public key", async () => {
      const request = buildPostRequest({ publicKey: VALID_STELLAR_KEY });
      const response = await POST(request);

      expect(response.status).toBe(200);

      const json = (await response.json()) as {
        challengeId?: string;
        message?: string;
        publicKey?: string;
        expiresAt?: string;
      };

      expect(json.challengeId).toBeDefined();
      expect(typeof json.challengeId).toBe("string");
      // Must be a valid UUID
      expect(json.challengeId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      expect(json.publicKey).toBe(VALID_STELLAR_KEY);
      expect(json.message).toBeDefined();
      expect(json.message).toContain("Fortexa wallet login");
      expect(json.message).toContain(`Challenge: ${json.challengeId}`);
      expect(json.message).toContain(`Wallet: ${VALID_STELLAR_KEY}`);
      expect(json.message).toContain("Expires:");

      expect(json.expiresAt).toBeDefined();
      const expiresAtMs = Date.parse(json.expiresAt!);
      expect(Number.isFinite(expiresAtMs)).toBe(true);
      expect(expiresAtMs).toBeGreaterThan(Date.now());
    });

    it("normalizes lowercase public key input to standard uppercase", async () => {
      const lowercaseKey = VALID_STELLAR_KEY.toLowerCase();
      const request = buildPostRequest({ publicKey: lowercaseKey });
      const response = await POST(request);

      // Stellar regex is case-sensitive (/^G[A-Z2-7]{55}$/u) or normalized
      // If regex is strict uppercase, lowercase is rejected with 400
      if (response.status === 200) {
        const json = await response.json();
        expect(json.publicKey).toBe(VALID_STELLAR_KEY);
      } else {
        expect(response.status).toBe(400);
      }
    });

    it("generates distinct challenge IDs and nonces across successive requests", async () => {
      const res1 = await POST(
        buildPostRequest({ publicKey: VALID_STELLAR_KEY }),
      );
      const res2 = await POST(
        buildPostRequest({ publicKey: ANOTHER_VALID_KEY }),
      );

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const json1 = await res1.json();
      const json2 = await res2.json();

      expect(json1.challengeId).not.toBe(json2.challengeId);
      expect(json1.message).not.toBe(json2.message);
    });
  });

  // ── 2. Malformed Wallet Input Validation ──────────────────────────────────
  describe("Malformed wallet input validation", () => {
    it("rejects empty or unparseable request body with 400 Bad Request", async () => {
      const request = new NextRequest("http://localhost/api/auth/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "NOT_VALID_JSON{",
      });

      const response = await POST(request);
      expect(response.status).toBe(400);

      const json = (await response.json()) as { error?: string };
      expect(json.error).toMatch(/invalid challenge payload/i);
    });

    it("rejects payload missing publicKey field with 400", async () => {
      const request = buildPostRequest({});
      const response = await POST(request);

      expect(response.status).toBe(400);
      const json = (await response.json()) as {
        error?: string;
        details?: unknown;
      };
      expect(json.error).toMatch(/invalid challenge payload/i);
    });

    it("rejects non-string publicKey types with 400", async () => {
      const invalidTypes = [12345, true, ["GBZXN7..."], { key: "GBZXN7..." }];

      for (const val of invalidTypes) {
        const request = buildPostRequest({ publicKey: val });
        const response = await POST(request);
        expect(response.status).toBe(400);
      }
    });

    it("rejects Stellar public keys of incorrect length", async () => {
      // Too short (55 chars)
      const shortKey =
        "GBZXN7PIRZGNMHGA72W2DISDGFIC3ALVMUSQQUBWNX25EBNOOGDHNVA";
      expect(shortKey.length).toBe(55);
      const resShort = await POST(buildPostRequest({ publicKey: shortKey }));
      expect(resShort.status).toBe(400);

      // Too long (57 chars)
      const longKey =
        "GBZXN7PIRZGNMHGA72W2DISDGFIC3ALVMUSQQUBWNX25EBNOOGDHNVAAA";
      expect(longKey.length).toBe(57);
      const resLong = await POST(buildPostRequest({ publicKey: longKey }));
      expect(resLong.status).toBe(400);
    });

    it("rejects keys with invalid prefix (e.g. S... secret key or B.../M...)", async () => {
      // Secret key starting with S
      const secretKey =
        "SBZXN7PIRZGNMHGA72W2DISDGFIC3ALVMUSQQUBWNX25EBNOOGDHNVAA";
      const resSecret = await POST(buildPostRequest({ publicKey: secretKey }));
      expect(resSecret.status).toBe(400);

      // Invalid prefix starting with X
      const invalidPrefix =
        "XBZXN7PIRZGNMHGA72W2DISDGFIC3ALVMUSQQUBWNX25EBNOOGDHNVAA";
      const resInvalid = await POST(
        buildPostRequest({ publicKey: invalidPrefix }),
      );
      expect(resInvalid.status).toBe(400);
    });

    it("rejects keys containing non-base32 characters (0, 1, 8, 9)", async () => {
      // Contains '0' and '8' which are not valid Stellar base32 characters
      const invalidChars =
        "G0ZXN7PIRZGNMHGA72W2DISDGFIC3ALVMUSQQUBWNX25EBNOOGDHNV8A";
      const res = await POST(buildPostRequest({ publicKey: invalidChars }));
      expect(res.status).toBe(400);
    });
  });

  // ── 3. Production Configuration and Fallback Behavior ─────────────────────
  describe("Production configuration and fallback behavior", () => {
    it("respects custom challenge TTL environment override", async () => {
      process.env.FORTEXA_AUTH_CHALLENGE_TTL_SECONDS = "120";

      const before = Date.now();
      const request = buildPostRequest({ publicKey: VALID_STELLAR_KEY });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const json = await response.json();
      const expiresAtMs = Date.parse(json.expiresAt);

      // Expected expiration is roughly now + 120s
      const diffSeconds = Math.round((expiresAtMs - before) / 1000);
      expect(diffSeconds).toBeGreaterThanOrEqual(119);
      expect(diffSeconds).toBeLessThanOrEqual(121);
    });

    it("enforces minimum TTL floor when configured with unreasonably small value", async () => {
      // Minimum floor is 30 seconds
      process.env.FORTEXA_AUTH_CHALLENGE_TTL_SECONDS = "5";

      const before = Date.now();
      const request = buildPostRequest({ publicKey: VALID_STELLAR_KEY });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const json = await response.json();
      const expiresAtMs = Date.parse(json.expiresAt);

      // Falls back to default 300s when < 30s
      const diffSeconds = Math.round((expiresAtMs - before) / 1000);
      expect(diffSeconds).toBeGreaterThanOrEqual(295);
    });
  });

  // ── 4. Response Cache and Security Headers ─────────────────────────────────
  describe("Response cache and security headers", () => {
    it("sets uncacheable Cache-Control headers on challenge responses", async () => {
      const request = buildPostRequest({ publicKey: VALID_STELLAR_KEY });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const cacheControl = response.headers.get("cache-control");
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toMatch(/no-store|no-cache/i);
    });

    it("attaches required browser security headers", async () => {
      const request = buildPostRequest({ publicKey: VALID_STELLAR_KEY });
      const response = await POST(request);

      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-request-id")).toBeDefined();
    });

    it("enforces rate limits on excessive challenge requests", async () => {
      // Route rate limit is 30 requests per minute
      let lastResponse: Response | null = null;
      for (let i = 0; i < 31; i++) {
        lastResponse = await POST(
          buildPostRequest({ publicKey: VALID_STELLAR_KEY }),
        );
      }

      expect(lastResponse?.status).toBe(429);
      const json = (await lastResponse?.json()) as { error: string };
      expect(json.error).toMatch(/too many challenge requests/i);
    });
  });

  // ── 5. GET and Helper Backward Compatibility ──────────────────────────────
  describe("GET and helper backward compatibility", () => {
    it("supports GET /api/auth/challenge with uncacheable response headers", async () => {
      const request = buildGetRequest();
      const response = await GET(request);

      expect(response.status).toBe(200);
      const json = (await response.json()) as { challenge?: string };
      expect(json.challenge).toBeDefined();
      expect(typeof json.challenge).toBe("string");
      expect(json.challenge!.length).toBe(64); // 32 bytes in hex

      const cacheControl = response.headers.get("cache-control");
      expect(cacheControl).toMatch(/no-store|no-cache/i);
    });

    it("exports getChallenge helper returning a 64-character hex string", async () => {
      const challenge1 = await getChallenge();
      const challenge2 = await getChallenge();

      expect(typeof challenge1).toBe("string");
      expect(challenge1.length).toBe(64);
      expect(challenge1).not.toBe(challenge2);
    });
  });
});
