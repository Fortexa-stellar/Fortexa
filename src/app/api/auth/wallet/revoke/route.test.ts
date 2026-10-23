import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { DELETE as revokeWallet } from "@/app/api/auth/wallet/revoke/route";
import {
  AUTH_COOKIE_KEY,
  createSessionToken,
  type AuthRole,
} from "@/lib/auth/session";
import {
  getUserWallet,
  revokeUserWallet,
  upsertUserWallet,
} from "@/lib/storage/user-wallet-store";
import * as userWalletStore from "@/lib/storage/user-wallet-store";
import { resetRateLimitStore } from "@/lib/security/rate-limit";

const TEST_SECRET = "revoke-route-test-secret-key-352";
const TEST_OPERATOR_ID = "usr_operator_352";
const TEST_VIEWER_ID = "usr_viewer_352";
const TEST_OTHER_OPERATOR_ID = "usr_operator_other_352";

const VALID_PUBLIC_KEY =
  "GBZXN7PIRZGNMHGA72W2DISDGFIC3ALVMUSQQUBWNX25EBNOOGDHNVAA";
const OTHER_PUBLIC_KEY =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function createAuthCookie(role: AuthRole, userId: string): string {
  return createSessionToken({
    email: `${userId}@fortexa.test`,
    role,
    userId,
    roles: [role],
  });
}

function buildRevokeRequest(
  cookieToken?: string,
  extraHeaders?: Record<string, string>,
) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (cookieToken) {
    headers.cookie = `${AUTH_COOKIE_KEY}=${cookieToken}`;
  }
  return new NextRequest("http://localhost/api/auth/wallet/revoke", {
    method: "DELETE",
    headers,
  });
}

describe("DELETE /api/auth/wallet/revoke route boundary tests (#352)", () => {
  beforeEach(async () => {
    process.env.FORTEXA_AUTH_SECRET = TEST_SECRET;
    delete process.env.DATABASE_URL;
    await resetRateLimitStore();
    // Clean up test wallets
    await revokeUserWallet(TEST_OPERATOR_ID).catch(() => undefined);
    await revokeUserWallet(TEST_VIEWER_ID).catch(() => undefined);
    await revokeUserWallet(TEST_OTHER_OPERATOR_ID).catch(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await revokeUserWallet(TEST_OPERATOR_ID).catch(() => undefined);
    await revokeUserWallet(TEST_VIEWER_ID).catch(() => undefined);
    await revokeUserWallet(TEST_OTHER_OPERATOR_ID).catch(() => undefined);
  });

  describe("Authorization at route boundary", () => {
    it("rejects unauthenticated requests missing session cookie with 401 Unauthorized", async () => {
      const request = buildRevokeRequest();
      const response = await revokeWallet(request);

      expect(response.status).toBe(401);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toMatch(/unauthorized|login required/i);
    });

    it("rejects invalid or tampered session token with 401 Unauthorized", async () => {
      const request = buildRevokeRequest("malformed.tampered.token");
      const response = await revokeWallet(request);

      expect(response.status).toBe(401);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toMatch(/unauthorized|login required/i);
    });

    it("rejects requests from viewer role with 403 Forbidden", async () => {
      const viewerCookie = createAuthCookie("viewer", TEST_VIEWER_ID);
      const request = buildRevokeRequest(viewerCookie);
      const response = await revokeWallet(request);

      expect(response.status).toBe(403);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toMatch(/forbidden|insufficient permissions/i);
    });

    it("permits requests from operator role with valid session", async () => {
      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);
      const request = buildRevokeRequest(operatorCookie);
      const response = await revokeWallet(request);

      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok?: boolean;
        message?: string;
      };
      expect(json.ok).toBe(true);
      expect(json.message).toContain("revoked");
    });
  });

  describe("Wallet binding and revocation", () => {
    it("successfully revokes an active bound wallet for the authenticated operator", async () => {
      // 1. Bind an active wallet
      await upsertUserWallet(TEST_OPERATOR_ID, {
        publicKey: VALID_PUBLIC_KEY,
        source: "external",
        provider: "freighter",
      });

      // Verify wallet is bound
      const before = await getUserWallet(TEST_OPERATOR_ID);
      expect(before).not.toBeNull();
      expect((before as any)?.publicKey).toBe(VALID_PUBLIC_KEY);

      // 2. Call DELETE /api/auth/wallet/revoke
      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);
      const request = buildRevokeRequest(operatorCookie);
      const response = await revokeWallet(request);

      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok?: boolean;
        message?: string;
      };
      expect(json.ok).toBe(true);

      // 3. Confirm wallet is now revoked
      const after = await getUserWallet(TEST_OPERATOR_ID);
      expect(after).toBeNull();
    });

    it("isolates revocation to the authenticated operator without affecting other users", async () => {
      // Bind wallets for two different operators
      await upsertUserWallet(TEST_OPERATOR_ID, {
        publicKey: VALID_PUBLIC_KEY,
        source: "external",
      });
      await upsertUserWallet(TEST_OTHER_OPERATOR_ID, {
        publicKey: OTHER_PUBLIC_KEY,
        source: "external",
      });

      // Revoke operator 1
      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);
      const request = buildRevokeRequest(operatorCookie);
      const response = await revokeWallet(request);

      expect(response.status).toBe(200);

      // Operator 1 wallet is revoked
      expect(await getUserWallet(TEST_OPERATOR_ID)).toBeNull();

      // Operator 2 wallet remains bound and untouched
      const otherWallet = await getUserWallet(TEST_OTHER_OPERATOR_ID);
      expect(otherWallet).not.toBeNull();
      expect((otherWallet as any)?.publicKey).toBe(OTHER_PUBLIC_KEY);
    });
  });

  describe("Repeated revocation and idempotency", () => {
    it("returns 200 OK cleanly when no wallet is bound", async () => {
      // Ensure no wallet exists
      expect(await getUserWallet(TEST_OPERATOR_ID)).toBeNull();

      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);
      const request = buildRevokeRequest(operatorCookie);
      const response = await revokeWallet(request);

      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        ok?: boolean;
        message?: string;
      };
      expect(json.ok).toBe(true);
      expect(json.message).toContain("revoked");
    });

    it("handles multiple consecutive revocation calls idempotently", async () => {
      await upsertUserWallet(TEST_OPERATOR_ID, {
        publicKey: VALID_PUBLIC_KEY,
        source: "external",
      });

      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);

      // First call: revokes bound wallet
      const res1 = await revokeWallet(buildRevokeRequest(operatorCookie));
      expect(res1.status).toBe(200);
      expect(await getUserWallet(TEST_OPERATOR_ID)).toBeNull();

      // Second call: no-op, still returns 200
      const res2 = await revokeWallet(buildRevokeRequest(operatorCookie));
      expect(res2.status).toBe(200);

      // Third call: still returns 200
      const res3 = await revokeWallet(buildRevokeRequest(operatorCookie));
      expect(res3.status).toBe(200);
    });
  });

  describe("Stable error responses and failure resilience", () => {
    it("safely handles unexpected store errors with HTTP 500 without leaking stack traces", async () => {
      vi.spyOn(userWalletStore, "revokeUserWallet").mockRejectedValueOnce(
        new Error("Database connection pool terminated unexpectedly"),
      );

      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);
      const request = buildRevokeRequest(operatorCookie);
      const response = await revokeWallet(request);

      expect(response.status).toBe(500);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toBe(
        "Database connection pool terminated unexpectedly",
      );
    });

    it("attaches security headers to route responses", async () => {
      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);
      const request = buildRevokeRequest(operatorCookie);
      const response = await revokeWallet(request);

      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    });

    it("enforces rate limits on excessive revocation requests", async () => {
      const operatorCookie = createAuthCookie("operator", TEST_OPERATOR_ID);

      // Route rate limit is 10 requests per minute
      let lastResponse: any;
      for (let i = 0; i < 11; i++) {
        lastResponse = await revokeWallet(buildRevokeRequest(operatorCookie));
      }

      expect(lastResponse.status).toBe(429);
      const json = await lastResponse.json();
      expect(json.error).toMatch(/rate limit/i);
    });
  });
});
