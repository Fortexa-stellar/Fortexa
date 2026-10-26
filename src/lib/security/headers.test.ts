import { afterEach, describe, expect, it, vi } from "vitest";

import { NextResponse } from "next/server";

import {
  applySecurityHeaders,
  buildResponseSecurityHeaders,
  buildSecurityHeaders,
  securityHeadersForRequest,
} from "./headers";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildSecurityHeaders", () => {
  it("returns X-Content-Type-Options: nosniff", () => {
    const headers = buildSecurityHeaders();
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("returns X-Frame-Options: DENY", () => {
    const headers = buildSecurityHeaders();
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("returns Content-Security-Policy with expected directives", () => {
    const headers = buildSecurityHeaders();
    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("returns Permissions-Policy disabling camera, microphone, geolocation", () => {
    const headers = buildSecurityHeaders();
    expect(headers["Permissions-Policy"]).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("includes unsafe-inline and unsafe-eval in script-src in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const headers = buildSecurityHeaders();
    expect(headers["Content-Security-Policy"]).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    );
  });

  it("omits unsafe-inline from script-src in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = buildSecurityHeaders();
    const csp = headers["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});

describe("buildResponseSecurityHeaders", () => {
  it("contains the static header set plus the per-response headers", () => {
    const headers = buildResponseSecurityHeaders("request-123");

    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(headers[key]).toBe(value);
    }

    expect(headers["x-request-id"]).toBe("request-123");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });

  it("adds Cache-Control: no-store only when noStore is set", () => {
    expect(buildResponseSecurityHeaders("request-123")["Cache-Control"]).toBeUndefined();
    expect(buildResponseSecurityHeaders("request-123", { noStore: true })["Cache-Control"]).toBe(
      "no-store"
    );
  });
});

describe("applySecurityHeaders", () => {
  it("writes the full header set onto an existing response", () => {
    const response = NextResponse.json({ ok: true });
    applySecurityHeaders(response, "request-abc");

    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(response.headers.get(key)).toBe(value);
    }
    expect(response.headers.get("x-request-id")).toBe("request-abc");
  });

  it("marks the response no-store when requested", () => {
    const response = NextResponse.json({ decision: "APPROVE" });
    applySecurityHeaders(response, "request-abc", { noStore: true });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("securityHeadersForRequest", () => {
  it("reuses the incoming x-request-id", () => {
    const request = new Request("http://localhost/api/decision", {
      headers: { "x-request-id": "incoming-id" },
    });

    expect(securityHeadersForRequest(request)["x-request-id"]).toBe("incoming-id");
  });
});
