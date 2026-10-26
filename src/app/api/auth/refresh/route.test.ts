import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import {
  registerLoginFailure,
  resetLoginLockoutClock,
  resetLoginLockoutStore,
  setLoginLockoutClock,
} from "@/lib/auth/login-lockout";
import { buildSecurityHeaders } from "@/lib/security/headers";
import { POST } from "@/app/api/auth/refresh/route";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: "refresh-operator",
    publicKey: "GCDEFAULTTESTWALLET123",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

describe("/api/auth/refresh route", () => {
  beforeEach(async () => {
    await resetLoginLockoutStore();
    resetLoginLockoutClock();
  });

  afterEach(async () => {
    await resetLoginLockoutStore();
    resetLoginLockoutClock();
  });

  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/auth/refresh", { method: "POST" });
    const response = await POST(request);

    expect(response.status).toBe(401);
    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(response.headers.get(key)).toBe(value);
    }
  });

  it("returns 200 and rotates for authenticated user", async () => {
    await upsertUserWallet("refresh-operator", { publicKey: "GCDEFAULTTESTWALLET123", source: "external" });
    const request = new NextRequest("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: operatorCookie() },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      user: { userId: string; role: string };
    };

    expect(payload.ok).toBe(true);
    expect(payload.user.userId).toBe("refresh-operator");
    expect(payload.user.role).toBe("operator");

    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(response.headers.get(key)).toBe(value);
    }
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not issue a session while the account is locked out", async () => {
    await upsertUserWallet("refresh-operator", { publicKey: "GCDEFAULTTESTWALLET123", source: "external" });
    for (let i = 0; i < 5; i++) {
      await registerLoginFailure("GCDEFAULTTESTWALLET123", "unknown");
    }

    const request = new NextRequest("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: operatorCookie() },
    });

    const response = await POST(request);
    expect(response.status).toBe(401);

    const payload = (await response.json()) as {
      error?: string;
      user?: { userId: string; role: string };
    };

    expect(payload.error).toBe("Account is temporarily locked. Refresh token invalid.");
    expect(payload.user).toBeUndefined();
  });

  it("issues a session again after the lock expires", async () => {
    await upsertUserWallet("refresh-operator", { publicKey: "GCDEFAULTTESTWALLET123", source: "external" });
    for (let i = 0; i < 5; i++) {
      await registerLoginFailure("GCDEFAULTTESTWALLET123", "unknown");
    }

    const now = Date.now();
    setLoginLockoutClock(() => now + 15 * 60 * 1000);

    const request = new NextRequest("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: { cookie: operatorCookie() },
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      user: { userId: string; role: string };
    };

    expect(payload.ok).toBe(true);
    expect(payload.user.userId).toBe("refresh-operator");
  });
});
