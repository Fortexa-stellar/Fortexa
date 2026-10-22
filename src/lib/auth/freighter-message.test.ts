import { describe, expect, it, vi } from "vitest";

import { signFreighterMessage } from "@/lib/auth/freighter";
import { buildChallengeMessage } from "@/lib/auth/wallet-challenge";

type FreighterMessageTestClient = Parameters<typeof signFreighterMessage>[0]["freighter"];

function freighterMessageMock(overrides?: {
  isConnected?: ReturnType<typeof vi.fn>;
  signMessage?: ReturnType<typeof vi.fn>;
}): NonNullable<FreighterMessageTestClient> & {
  isConnected: ReturnType<typeof vi.fn>;
  signMessage: ReturnType<typeof vi.fn>;
} {
  return {
    isConnected: overrides?.isConnected ?? vi.fn().mockResolvedValue({ isConnected: true }),
    signMessage:
      overrides?.signMessage ??
      vi.fn().mockResolvedValue({
        signedMessage: "c2lnbmF0dXJl",
        signerAddress: "GABC",
      }),
  } as never;
}

describe("signFreighterMessage", () => {
  it("returns ok with base64 signature on success", async () => {
    const result = await signFreighterMessage({
      message: "Fortexa wallet login",
      freighter: freighterMessageMock(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signature).toBe("c2lnbmF0dXJl");
      expect(result.signerAddress).toBe("GABC");
    }
  });

  it("signs a login fixture that binds origin, nonce, and expiry", async () => {
    const message = buildChallengeMessage({
      challengeId: "11111111-1111-4111-8111-111111111111",
      publicKey: "GABC",
      expiresAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
      origin: "https://fortexa.example",
      nonce: "nonce-fixture",
    });
    const freighter = freighterMessageMock();

    const result = await signFreighterMessage({
      message,
      freighter,
    });

    expect(result.ok).toBe(true);
    expect(freighter.signMessage).toHaveBeenCalledWith(message, { address: undefined });
    expect(message).toContain("Origin: https://fortexa.example");
    expect(message).toContain("Nonce: nonce-fixture");
    expect(message).toContain("Expires: 2026-05-26T12:00:00.000Z");
  });

  it("flags user rejection when no signature is returned", async () => {
    const freighter = freighterMessageMock({
      signMessage: vi.fn().mockResolvedValue({ signedMessage: null, signerAddress: "" }),
    });

    const result = await signFreighterMessage({
      message: "Fortexa wallet login",
      freighter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rejected");
    }
  });
});
