import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWalletChallenge,
  hashSep53Message,
  resetWalletChallengeStore,
  verifyWalletChallenge,
} from "@/lib/auth/wallet-challenge";
import { resolveRoleByWallet } from "@/lib/auth/wallet-role";

// Fixed keypair — same seed used across all auth test files for consistency.
const AUTHORIZED_SECRET = "SAKICEVQLYWGSOJS4WW7HZJWAHZVEEBS527LHK5V4MLJALYKICQCJXMW";
const AUTHORIZED_PUBLIC_KEY = "GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L";

// Second fixed keypair — used for the mismatched-key evidence case.
// MISMATCHED_KEYPAIR.publicKey() !== AUTHORIZED_PUBLIC_KEY.
const MISMATCHED_SECRET = "SAM2DAXGSFRBTB6OGJJM4XRLGOZLKA6S6XECHLNXUN2JQ4NKSWMFCP6K";
const MISMATCHED_KEYPAIR = Keypair.fromSecret(MISMATCHED_SECRET);

function signSep53Message(secret: string, message: string) {
  const keypair = Keypair.fromSecret(secret);
  return keypair.sign(hashSep53Message(message)).toString("base64");
}

describe("wallet-auth challenge signing — reviewer evidence fixtures", () => {
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env.FORTEXA_OPERATOR_WALLETS;
    delete process.env.FORTEXA_AUTH_CHALLENGE_TTL_SECONDS;
    await resetWalletChallengeStore();
  });

  // ── Case 1 ─────────────────────────────────────────────────────────────────
  it("case 1 — valid pair: verifier accepts a challenge signed by the authorized keypair", async () => {
    process.env.FORTEXA_OPERATOR_WALLETS = AUTHORIZED_PUBLIC_KEY;

    const challenge = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY);
    const signature = signSep53Message(AUTHORIZED_SECRET, challenge.message);

    const result = await verifyWalletChallenge({
      challengeId: challenge.id,
      publicKey: AUTHORIZED_PUBLIC_KEY,
      signature,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.challenge.publicKey).toBe(AUTHORIZED_PUBLIC_KEY);
    }
  });

  // ── Case 2 ─────────────────────────────────────────────────────────────────
  it("case 2 — expired challenge: verifier explicitly rejects a challenge past its TTL", async () => {
    vi.useFakeTimers();
    process.env.FORTEXA_AUTH_CHALLENGE_TTL_SECONDS = "60";

    const challenge = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY);
    const signature = signSep53Message(AUTHORIZED_SECRET, challenge.message);

    vi.advanceTimersByTime(61_000);

    const result = await verifyWalletChallenge({
      challengeId: challenge.id,
      publicKey: AUTHORIZED_PUBLIC_KEY,
      signature,
    });

    expect(result).toEqual({ ok: false, code: "expired" });
  });

  // ── Case 3 ─────────────────────────────────────────────────────────────────
  it("case 3 — replayed challenge: verifier explicitly rejects a second use of the same challengeId", async () => {
    process.env.FORTEXA_OPERATOR_WALLETS = AUTHORIZED_PUBLIC_KEY;

    const challenge = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY);
    const signature = signSep53Message(AUTHORIZED_SECRET, challenge.message);
    const payload = {
      challengeId: challenge.id,
      publicKey: AUTHORIZED_PUBLIC_KEY,
      signature,
    };

    const first = await verifyWalletChallenge(payload);
    expect(first.ok).toBe(true);

    const second = await verifyWalletChallenge(payload);
    expect(second).toEqual({ ok: false, code: "replayed" });
  });

  // ── Case 4 ─────────────────────────────────────────────────────────────────
  it("case 4 — mismatched public key: verifier rejects a valid Ed25519 signature from the wrong keypair", async () => {
    const challenge = await createWalletChallenge(AUTHORIZED_PUBLIC_KEY);

    // Produce a well-formed 64-byte Ed25519 signature — but from MISMATCHED_KEYPAIR,
    // not from the keypair that owns AUTHORIZED_PUBLIC_KEY.
    const mismatchedSignature = MISMATCHED_KEYPAIR.sign(
      hashSep53Message(challenge.message)
    ).toString("base64");

    const result = await verifyWalletChallenge({
      challengeId: challenge.id,
      publicKey: AUTHORIZED_PUBLIC_KEY,
      signature: mismatchedSignature,
    });

    expect(result).toEqual({ ok: false, code: "invalid_signature" });
  });

  // ── Case 5 ─────────────────────────────────────────────────────────────────
  it("case 5 — unauthorized wallet role: resolveRoleByWallet returns null when wallet is absent from all role lists", () => {
    // Non-empty env disables open-dev fallback; only AUTHORIZED_PUBLIC_KEY is an operator.
    process.env.FORTEXA_OPERATOR_WALLETS = AUTHORIZED_PUBLIC_KEY;

    // MISMATCHED_KEYPAIR's public key is not in any role list.
    const role = resolveRoleByWallet(MISMATCHED_KEYPAIR.publicKey());

    expect(role).toBeNull();
  });
});
