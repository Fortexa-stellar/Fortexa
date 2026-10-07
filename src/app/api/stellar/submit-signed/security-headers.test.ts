import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => {
  process.env.FORTEXA_STORE_DIR = `/tmp/fortexa-submit-headers-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  process.env.FORTEXA_AUTH_SECRET = "submit-headers-test-secret";
  delete process.env.DATABASE_URL;
});

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { buildSecurityHeaders } from "@/lib/security/headers";
import { POST } from "./route";

function operatorCookie() {
  const token = createSessionToken({
    email: "submit-headers@fortexa.local",
    role: "operator",
    roles: ["operator", "signer"],
    userId: "submit-headers-user",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function expectSecurityHeaders(response: Response) {
  for (const [key, value] of Object.entries(buildSecurityHeaders())) {
    expect(response.headers.get(key)).toBe(value);
  }
}

function buildRequest(extraHeaders: Record<string, string>, body: unknown) {
  return new NextRequest("http://localhost/api/stellar/submit-signed", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe("POST /api/stellar/submit-signed security headers", () => {
  it("carries the header set on validation errors", async () => {
    const response = await POST(buildRequest({ cookie: operatorCookie() }, { signedXdr: "" }));

    expect(response.status).toBe(400);
    expectSecurityHeaders(response);
  });

  it("carries the header set on authentication errors", async () => {
    const response = await POST(buildRequest({}, { signedXdr: "AAAA" }));

    expect(response.status).toBe(401);
    expectSecurityHeaders(response);
  });
});
