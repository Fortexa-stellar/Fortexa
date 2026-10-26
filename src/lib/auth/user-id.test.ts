import { promises as fs } from "node:fs";

import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const storeDir = `/tmp/fortexa-user-id-${process.pid}`;

vi.hoisted(() => {
  process.env.FORTEXA_STORE_DIR = `/tmp/fortexa-user-id-${process.pid}`;
  process.env.FORTEXA_AUTH_SECRET = "user-id-test-secret";
  delete process.env.DATABASE_URL;
  delete process.env.FORTEXA_OPERATOR_WALLETS;
  delete process.env.FORTEXA_VIEWER_WALLETS;
});

const verifyWalletChallenge = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/wallet-challenge", () => ({
  verifyWalletChallenge,
}));

import { POST as decision } from "@/app/api/decision/route";
import { POST as login } from "@/app/api/auth/login/route";
import { AUTH_COOKIE_KEY, verifySessionToken } from "@/lib/auth/session";
import { userIdForWallet } from "@/lib/auth/user-id";
import { canPassDecisionGate } from "@/lib/decision/gate";
import {
  findUserWalletByPublicKey,
  revokeUserWallet,
  upsertUserWallet,
} from "@/lib/storage/user-wallet-store";

const PUBLIC_KEY = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";

function loginRequest(signature = "signature") {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: PUBLIC_KEY,
      challengeId: "11111111-1111-4111-8111-111111111111",
      signature,
    }),
  });
}

describe("wallet user id", () => {
  beforeEach(async () => {
    verifyWalletChallenge.mockReset();
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fs.rm(storeDir, { recursive: true, force: true });
  });

  it("returns the same user id for two successful logins with one key", async () => {
    verifyWalletChallenge.mockResolvedValue({
      ok: true,
      challenge: {
        id: "11111111-1111-4111-8111-111111111111",
        publicKey: PUBLIC_KEY,
        message: "challenge",
        expiresAtMs: Date.now() + 60_000,
      },
    });

    const first = await login(loginRequest());
    const second = await login(loginRequest());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstId = verifySessionToken(first.cookies.get(AUTH_COOKIE_KEY)?.value ?? "")?.userId;
    const secondId = verifySessionToken(second.cookies.get(AUTH_COOKIE_KEY)?.value ?? "")?.userId;
    expect(firstId).toBeTruthy();
    expect(secondId).toBe(firstId);

    const stored = await findUserWalletByPublicKey(PUBLIC_KEY);
    expect(stored?.userId).toBe(firstId);
  });

  it("does not create a user when challenge verification fails", async () => {
    verifyWalletChallenge.mockResolvedValue({ ok: false, code: "invalid_signature" });

    const response = await login(loginRequest("bad-signature"));
    expect(response.status).toBe(401);
    expect(await findUserWalletByPublicKey(PUBLIC_KEY)).toBeNull();
  });

  it("rejects a revoked user id at the decision gate", async () => {
    const userId = await userIdForWallet(PUBLIC_KEY);
    await upsertUserWallet(userId, {
      publicKey: PUBLIC_KEY,
      source: "external",
      provider: "test",
    });
    expect(await canPassDecisionGate(userId)).toBe(true);

    await revokeUserWallet(userId);
    expect(await canPassDecisionGate(userId)).toBe(false);

    const { createSessionToken } = await import("@/lib/auth/session");
    const token = createSessionToken({
      email: `wallet:${PUBLIC_KEY}`,
      role: "operator",
      userId,
      expiresInSeconds: 120,
    });
    const response = await decision(
      new NextRequest("http://localhost/api/decision", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${AUTH_COOKIE_KEY}=${token}`,
        },
        body: JSON.stringify({ scenarioId: "safe-research-payment" }),
      })
    );

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("revoked");
  });
});
