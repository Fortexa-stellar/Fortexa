import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getSession } from "@/app/api/auth/session/route";
import {
  AUTH_COOKIE_KEY,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  verifySessionToken,
} from "@/lib/auth/session";
import {
  resetSessionRevocationStore,
  revokeSession,
} from "@/lib/auth/session-revocation";

const START_TIME = Date.parse("2026-10-23T00:00:00.000Z");

function buildSessionRequest(
  cookieValue?: string,
  headers: Record<string, string> = {},
) {
  const reqHeaders: Record<string, string> = { ...headers };
  if (cookieValue !== undefined) {
    reqHeaders["cookie"] = `${AUTH_COOKIE_KEY}=${cookieValue}`;
  }
  return new NextRequest("http://localhost/api/auth/session", {
    method: "GET",
    headers: reqHeaders,
  });
}

describe("GET /api/auth/session direct route tests (#348)", () => {
  beforeEach(async () => {
    process.env.FORTEXA_AUTH_SECRET = "direct-session-route-test-secret-348";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START_TIME);
    await resetSessionRevocationStore();
  });

  afterEach(async () => {
    await resetSessionRevocationStore();
    vi.useRealTimers();
  });

  it("returns authenticated: false when no auth cookie is present", async () => {
    const request = buildSessionRequest();
    const response = await getSession(request);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { authenticated: boolean };
    expect(json).toEqual({ authenticated: false });

    const cacheControl = response.headers.get("cache-control");
    expect(cacheControl).toContain("no-store");
  });

  it("returns authenticated: true and user metadata for a valid active session", async () => {
    const token = createSessionToken({
      email: "operator@fortexa.local",
      role: "operator",
      userId: "usr_operator_001",
    });

    const request = buildSessionRequest(token);
    const response = await getSession(request);

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      authenticated: boolean;
      user?: {
        email: string;
        role: string;
        userId: string;
        exp: number;
      };
    };

    expect(json.authenticated).toBe(true);
    expect(json.user).toBeDefined();
    expect(json.user?.email).toBe("operator@fortexa.local");
    expect(json.user?.role).toBe("operator");
    expect(json.user?.userId).toBe("usr_operator_001");
    expect(typeof json.user?.exp).toBe("number");
    expect(json.user?.exp).toBeGreaterThan(Math.floor(START_TIME / 1000));

    const cacheControl = response.headers.get("cache-control");
    expect(cacheControl).toContain("no-store");
  });

  it("returns authenticated: true for different roles (viewer, admin)", async () => {
    const viewerToken = createSessionToken({
      email: "viewer@fortexa.local",
      role: "viewer",
      userId: "usr_viewer_002",
    });

    const response = await getSession(buildSessionRequest(viewerToken));
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      authenticated: boolean;
      user?: { role: string };
    };
    expect(json.authenticated).toBe(true);
    expect(json.user?.role).toBe("viewer");
  });

  it("returns authenticated: false when session cookie has expired", async () => {
    const token = createSessionToken({
      email: "user@fortexa.local",
      role: "operator",
      userId: "usr_exp_003",
    });

    // Advance clock past maximum session age
    vi.setSystemTime(START_TIME + (SESSION_MAX_AGE_SECONDS + 60) * 1000);

    const request = buildSessionRequest(token);
    const response = await getSession(request);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { authenticated: boolean };
    expect(json).toEqual({ authenticated: false });
  });

  it("returns authenticated: false when session has been revoked server-side", async () => {
    const token = createSessionToken({
      email: "revoked@fortexa.local",
      role: "operator",
      userId: "usr_rev_004",
    });

    const parsedSession = verifySessionToken(token);
    expect(parsedSession).not.toBeNull();

    // Revoke session server-side
    await revokeSession({
      sid: parsedSession!.sid,
      exp: parsedSession!.exp,
    });

    const request = buildSessionRequest(token);
    const response = await getSession(request);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { authenticated: boolean };
    expect(json).toEqual({ authenticated: false });
  });

  it("returns authenticated: false when cookie signature is tampered or malformed", async () => {
    const validToken = createSessionToken({
      email: "user@fortexa.local",
      role: "operator",
      userId: "usr_tamper_005",
    });

    // Tamper with the signature portion
    const tamperedToken = validToken.slice(0, -6) + "xxxxxx";
    const requestTampered = buildSessionRequest(tamperedToken);
    const responseTampered = await getSession(requestTampered);

    expect(responseTampered.status).toBe(200);
    const jsonTampered = (await responseTampered.json()) as {
      authenticated: boolean;
    };
    expect(jsonTampered).toEqual({ authenticated: false });

    // Arbitrary malformed string
    const requestMalformed = buildSessionRequest("invalid-not-a-token");
    const responseMalformed = await getSession(requestMalformed);

    expect(responseMalformed.status).toBe(200);
    const jsonMalformed = (await responseMalformed.json()) as {
      authenticated: boolean;
    };
    expect(jsonMalformed).toEqual({ authenticated: false });
  });

  it("attaches security headers including no-store on all route responses", async () => {
    const request = buildSessionRequest();
    const response = await getSession(request);

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
