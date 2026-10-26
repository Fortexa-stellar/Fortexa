import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as refresh } from "@/app/api/auth/refresh/route";
import { GET as getSession } from "@/app/api/auth/session/route";
import {
  AUTH_COOKIE_KEY,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  verifySessionToken,
} from "@/lib/auth/session";
import { isSessionRevoked, resetSessionRevocationStore } from "@/lib/auth/session-revocation";

// Route-level tests only: requests are built directly and every cookie is sent
// as a raw header, so nothing depends on a browser dropping a cleared cookie.

const START = Date.parse("2026-09-29T12:00:00.000Z");

function loginToken(userId = "wallet:GOPERATOR") {
  // Same call the login route makes: no session id, so a fresh one is minted.
  return createSessionToken({ email: userId, role: "operator", userId });
}

function withCookie(url: string, method: "GET" | "POST", token: string) {
  return new NextRequest(url, { method, headers: { cookie: `${AUTH_COOKIE_KEY}=${token}` } });
}

async function sessionFor(token: string) {
  const response = await getSession(withCookie("http://localhost/api/auth/session", "GET", token));
  return (await response.json()) as { authenticated: boolean; user?: { userId: string } };
}

async function logoutWith(token: string) {
  return logout(withCookie("http://localhost/api/auth/logout", "POST", token));
}

async function refreshWith(token: string) {
  return refresh(withCookie("http://localhost/api/auth/refresh", "POST", token));
}

function sessionIdOf(token: string) {
  const session = verifySessionToken(token, { allowStaleGeneration: true });
  if (!session) {
    throw new Error("token does not verify");
  }
  return session.sid;
}

describe("logout invalidates the session server-side", () => {
  beforeEach(async () => {
    process.env.FORTEXA_AUTH_SECRET = "logout-route-test-secret";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    await resetSessionRevocationStore();
  });

  afterEach(async () => {
    await resetSessionRevocationStore();
    vi.useRealTimers();
  });

  it("returns an authenticated session before logout", async () => {
    const token = loginToken();

    const session = await sessionFor(token);

    expect(session.authenticated).toBe(true);
    expect(session.user?.userId).toBe("wallet:GOPERATOR");
  });

  it("makes the session route unauthenticated for the old cookie after logout", async () => {
    const oldCookie = loginToken();

    const response = await logoutWith(oldCookie);
    expect(response.status).toBe(200);
    expect(response.cookies.get(AUTH_COOKIE_KEY)?.value).toBe("");

    // The captured cookie still carries a valid signature...
    expect(verifySessionToken(oldCookie)).not.toBeNull();
    // ...but the store has revoked it, which is what the session route reads.
    expect(await isSessionRevoked(sessionIdOf(oldCookie))).toBe(true);
    expect(await sessionFor(oldCookie)).toEqual({ authenticated: false });
  });

  it("refuses to refresh the old cookie after logout and mints no new generation", async () => {
    const oldCookie = loginToken();
    await logoutWith(oldCookie);

    const response = await refreshWith(oldCookie);

    expect(response.status).toBe(401);
    expect(response.cookies.get(AUTH_COOKIE_KEY)).toBeUndefined();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("carries the session id across refresh so each generation belongs to one session", async () => {
    const first = loginToken();
    vi.setSystemTime(START + 60_000);

    const response = await refreshWith(first);
    const second = response.cookies.get(AUTH_COOKIE_KEY)?.value ?? "";

    expect(response.status).toBe(200);
    expect(second).not.toBe(first);
    expect(sessionIdOf(second)).toBe(sessionIdOf(first));
  });

  it("revokes every generation, whichever generation logs out", async () => {
    const gen1 = loginToken();
    vi.setSystemTime(START + 60_000);
    const gen2 = (await refreshWith(gen1)).cookies.get(AUTH_COOKIE_KEY)?.value ?? "";
    vi.setSystemTime(START + 120_000);
    const gen3 = (await refreshWith(gen2)).cookies.get(AUTH_COOKIE_KEY)?.value ?? "";

    expect(new Set([gen1, gen2, gen3]).size).toBe(3);
    for (const token of [gen1, gen2, gen3]) {
      expect((await sessionFor(token)).authenticated).toBe(true);
    }

    // Log out with the oldest copy; the newest must die too.
    await logoutWith(gen1);

    for (const token of [gen1, gen2, gen3]) {
      expect(await sessionFor(token)).toEqual({ authenticated: false });
      expect((await refreshWith(token)).status).toBe(401);
    }
  });

  it("keeps a newer generation revoked after the generation used to log out has expired", async () => {
    const gen1 = createSessionToken({
      email: "u",
      role: "operator",
      userId: "u",
      expiresInSeconds: 60,
    });
    vi.setSystemTime(START + 30_000);
    const gen2 = (await refreshWith(gen1)).cookies.get(AUTH_COOKIE_KEY)?.value ?? "";

    await logoutWith(gen1);

    // gen1 is long expired; gen2 is still inside its own lifetime.
    vi.setSystemTime(START + 30_000 + (SESSION_MAX_AGE_SECONDS - 60) * 1000);
    expect(verifySessionToken(gen2)).not.toBeNull();
    expect(await sessionFor(gen2)).toEqual({ authenticated: false });
    expect((await refreshWith(gen2)).status).toBe(401);
  });

  it("leaves other sessions of the same user authenticated", async () => {
    const laptop = loginToken("wallet:GSHARED");
    const phone = loginToken("wallet:GSHARED");

    await logoutWith(laptop);

    expect((await sessionFor(laptop)).authenticated).toBe(false);
    expect((await sessionFor(phone)).authenticated).toBe(true);
  });

  it("clears the cookie without error when logout has no valid session", async () => {
    const response = await logout(
      new NextRequest("http://localhost/api/auth/logout", { method: "POST" })
    );

    expect(response.status).toBe(200);
    expect(response.cookies.get(AUTH_COOKIE_KEY)?.value).toBe("");
  });
});

describe("logout revocation in the shared security state", () => {
  let stateDir: string;

  beforeEach(() => {
    process.env.FORTEXA_AUTH_SECRET = "logout-route-test-secret";
    stateDir = mkdtempSync(path.join(tmpdir(), "fortexa-session-revocation-"));
    process.env.FORTEXA_SHARED_STATE_PATH = path.join(stateDir, "shared-state.json");
  });

  afterEach(() => {
    delete process.env.FORTEXA_SHARED_STATE_PATH;
    rmSync(stateDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("rejects the old cookie on another instance that never saw the logout", async () => {
    const token = loginToken();
    await logoutWith(token);

    // A fresh module graph has an empty in-memory revocation map, like a
    // second server process. Only the shared store can reject the cookie.
    vi.resetModules();
    const otherInstance = await import("@/app/api/auth/session/route");
    const response = await otherInstance.GET(
      withCookie("http://localhost/api/auth/session", "GET", token)
    );

    expect(await response.json()).toEqual({ authenticated: false });
  });
});
