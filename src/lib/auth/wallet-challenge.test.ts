import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildChallengeMessage,
  createWalletChallenge,
  hashSep53Message,
  resetWalletChallengeStore,
  verifyWalletChallenge,
  verifyWalletSignature,
} from "@/lib/auth/wallet-challenge";

const TEST_SECRET = "SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW";
const TEST_PUBLIC_KEY = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";

function signSep53Message(secret: string, message: string) {
  const keypair = Keypair.fromSecret(secret);
  return keypair.sign(hashSep53Message(message)).toString("base64");
}

describe("wallet challenge", () => {
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.FORTEXA_AUTH_CHALLENGE_TTL_SECONDS;
    await resetWalletChallengeStore();
    delete process.env.FORTEXA_SHARED_STATE_PATH;
  });

  it("creates a challenge message bound to wallet and expiry", async () => {
    const challenge = await createWalletChallenge(TEST_PUBLIC_KEY);

    expect(challenge.message).toContain(`Wallet: ${TEST_PUBLIC_KEY}`);
    expect(challenge.message).toContain(`Challenge: ${challenge.id}`);
    expect(challenge.expiresAtMs).toBeGreaterThan(Date.now());
    expect(challenge.message).toContain(`Origin: ${challenge.origin}`);
    expect(challenge.message).toContain(`Nonce: ${challenge.nonce}`);
    expect(challenge.message).toContain("Expires: ");
    expect(
      buildChallengeMessage({
        challengeId: challenge.id,
        publicKey: challenge.publicKey,
        expiresAtMs: challenge.expiresAtMs,
        origin: challenge.origin,
        nonce: challenge.nonce,
      })
    ).toBe(challenge.message);
  });

  it("verifies a valid SEP-53 signature and consumes the challenge", async () => {
    const challenge = await createWalletChallenge(TEST_PUBLIC_KEY);
    const signature = signSep53Message(TEST_SECRET, challenge.message);

    expect(verifyWalletSignature(TEST_PUBLIC_KEY, challenge.message, signature)).toBe(true);

    const verified = await verifyWalletChallenge({
      challengeId: challenge.id,
      publicKey: TEST_PUBLIC_KEY,
      signature,
    });

    expect(verified.ok).toBe(true);

    const replayed = await verifyWalletChallenge({
      challengeId: challenge.id,
      publicKey: TEST_PUBLIC_KEY,
      signature,
    });

    expect(replayed).toEqual({ ok: false, code: "missing" });
  });

  it("rejects expired challenges", async () => {
    process.env.FORTEXA_AUTH_CHALLENGE_TTL_SECONDS = "60";
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const clock = () => now;

    const challenge = await createWalletChallenge(TEST_PUBLIC_KEY, clock);
    const signature = signSep53Message(TEST_SECRET, challenge.message);

    now += 61_000;

    const result = await verifyWalletChallenge(
      {
        challengeId: challenge.id,
        publicKey: TEST_PUBLIC_KEY,
        signature,
      },
      clock
    );

    expect(result).toEqual({ ok: false, code: "expired" });
    expect(
      await verifyWalletChallenge(
        {
          challengeId: challenge.id,
          publicKey: TEST_PUBLIC_KEY,
          signature,
        },
        clock
      )
    ).toEqual({ ok: false, code: "missing" });
  });

  it("consumes a challenge when a different wallet key signs it", async () => {
    const challenge = await createWalletChallenge(TEST_PUBLIC_KEY);
    const otherKeypair = Keypair.random();
    const otherSignature = otherKeypair
      .sign(hashSep53Message(challenge.message))
      .toString("base64");

    expect(
      await verifyWalletChallenge({
        challengeId: challenge.id,
        publicKey: otherKeypair.publicKey(),
        signature: otherSignature,
      })
    ).toEqual({ ok: false, code: "wallet_mismatch" });

    expect(
      await verifyWalletChallenge({
        challengeId: challenge.id,
        publicKey: TEST_PUBLIC_KEY,
        signature: signSep53Message(TEST_SECRET, challenge.message),
      })
    ).toEqual({ ok: false, code: "missing" });
  });

  it("rejects invalid signatures without allowing replay", async () => {
    const challenge = await createWalletChallenge(TEST_PUBLIC_KEY);
    const otherKeypair = Keypair.random();
    const badSignature = otherKeypair.sign(hashSep53Message(challenge.message)).toString("base64");

    const result = await verifyWalletChallenge({
      challengeId: challenge.id,
      publicKey: TEST_PUBLIC_KEY,
      signature: badSignature,
    });

    expect(result).toEqual({ ok: false, code: "invalid_signature" });

    const replayed = await verifyWalletChallenge({
      challengeId: challenge.id,
      publicKey: TEST_PUBLIC_KEY,
      signature: badSignature,
    });

    expect(replayed).toEqual({ ok: false, code: "missing" });
  });
});
