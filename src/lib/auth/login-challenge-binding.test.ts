import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as login } from "@/app/api/auth/login/route";
import { POST as updatePolicy } from "@/app/api/policy/route";
import { POST as pay } from "@/app/api/stellar/pay/route";
import { POST as submitSigned } from "@/app/api/stellar/submit-signed/route";
import { AUTH_COOKIE_KEY } from "@/lib/auth/session";
import {
  buildChallengeMessage,
  createWalletChallenge,
  hashSep53Message,
  resetWalletChallengeStore,
} from "@/lib/auth/wallet-challenge";
import { resetLoginLockoutStore } from "@/lib/auth/login-lockout";
import * as stellarClient from "@/lib/stellar/client";

const AUTHORIZED_SECRET = "SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW";
const AUTHORIZED_PUBLIC_KEY = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";

function signSep53Message(secret: string, message: string) {
  return Keypair.fromSecret(secret).sign(hashSep53Message(message)).toString("base64");
}

function loginRequest(body: unknown) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://fortexa.example" },
    body: JSON.stringify(body),
  });
}

describe("login challenge binding", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.FORTEXA_OPERATOR_WALLETS;
    delete process.env.FORTEXA_AUTH_SECRET;
    await resetWalletChallengeStore();
    await resetLoginLockoutStore();
  });

  it("accepts a signature over the current challenge once and rejects it on submit-signed", async () => {
    process.env.FORTEXA_AUTH_SECRET = "login-challenge-binding-secret";
    process.env.FORTEXA_OPERATOR_WALLETS = AUTHORIZED_PUBLIC_KEY;
    const submit = vi.spyOn(stellarClient, "submitSignedTransactionXdr");

    const challenge = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY, {
      origin: "https://fortexa.example",
      nonce: "nonce-current",
    });
    const signature = signSep53Message(AUTHORIZED_SECRET, challenge.message);

    const first = await login(
      loginRequest({
        publicKey: AUTHORIZED_PUBLIC_KEY,
        challengeId: challenge.id,
        signature,
      })
    );
    expect(first.status).toBe(200);
    const cookie = first.cookies.get(AUTH_COOKIE_KEY)?.value;
    expect(cookie).toBeTruthy();

    const replay = await login(
      loginRequest({
        publicKey: AUTHORIZED_PUBLIC_KEY,
        challengeId: challenge.id,
        signature,
      })
    );
    expect(replay.status).toBe(400);

    const submitResponse = await submitSigned(
      new NextRequest("http://localhost/api/stellar/submit-signed", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${AUTH_COOKIE_KEY}=${cookie}`,
        },
        body: JSON.stringify({ signedXdr: signature }),
      })
    );
    expect(submitResponse.status).toBe(400);
    const submitPayload = (await submitResponse.json()) as { error: string };
    expect(submitPayload.error).toContain("Login signatures");
    expect(submit).not.toHaveBeenCalled();

    const payResponse = await pay(
      new NextRequest("http://localhost/api/stellar/pay", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${AUTH_COOKIE_KEY}=${cookie}`,
        },
        body: JSON.stringify({ message: challenge.message, signature }),
      })
    );
    expect(payResponse.status).toBe(400);

    const policyResponse = await updatePolicy(
      new NextRequest("http://localhost/api/policy", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${AUTH_COOKIE_KEY}=${cookie}`,
        },
        body: JSON.stringify({ note: challenge.message }),
      })
    );
    expect(policyResponse.status).toBe(400);
  });

  it("rejects a signature over a different origin or nonce", async () => {
    process.env.FORTEXA_AUTH_SECRET = "login-challenge-binding-secret";
    process.env.FORTEXA_OPERATOR_WALLETS = AUTHORIZED_PUBLIC_KEY;

    const challenge = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY, {
      origin: "https://fortexa.example",
      nonce: "nonce-current",
    });

    const wrongOrigin = buildChallengeMessage({
      challengeId: challenge.id,
      publicKey: challenge.publicKey,
      expiresAtMs: challenge.expiresAtMs,
      origin: "https://evil.example",
      nonce: challenge.nonce,
    });
    const originResponse = await login(
      loginRequest({
        publicKey: AUTHORIZED_PUBLIC_KEY,
        challengeId: challenge.id,
        signature: signSep53Message(AUTHORIZED_SECRET, wrongOrigin),
      })
    );
    expect(originResponse.status).toBe(401);

    const second = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY, {
      origin: "https://fortexa.example",
      nonce: "nonce-current",
    });
    const wrongNonce = buildChallengeMessage({
      challengeId: second.id,
      publicKey: second.publicKey,
      expiresAtMs: second.expiresAtMs,
      origin: second.origin,
      nonce: "other-nonce",
    });
    const nonceResponse = await login(
      loginRequest({
        publicKey: AUTHORIZED_PUBLIC_KEY,
        challengeId: second.id,
        signature: signSep53Message(AUTHORIZED_SECRET, wrongNonce),
      })
    );
    expect(nonceResponse.status).toBe(401);
  });

  it("does not log the signature or the raw login message when verification fails", async () => {
    process.env.FORTEXA_AUTH_SECRET = "login-challenge-binding-secret";
    process.env.FORTEXA_OPERATOR_WALLETS = AUTHORIZED_PUBLIC_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const challenge = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY, {
      origin: "https://fortexa.example",
      nonce: "nonce-secret",
    });
    const signature = signSep53Message(
      AUTHORIZED_SECRET,
      "Fortexa wallet login\nnot the stored challenge"
    );

    const response = await login(
      loginRequest({
        publicKey: AUTHORIZED_PUBLIC_KEY,
        challengeId: challenge.id,
        signature,
      })
    );
    expect(response.status).toBe(401);

    const logged = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls]
      .flat()
      .map((part) => String(part))
      .join("\n");
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain(challenge.message);
    expect(logged).not.toContain("nonce-secret");
  });
});
