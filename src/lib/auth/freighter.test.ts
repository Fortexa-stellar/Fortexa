import { describe, expect, it, vi } from "vitest";

import { signFreighterXdr } from "@/lib/auth/freighter";

const EXPECTED_PASSPHRASE = "Test SDF Network ; September 2015";

type FreighterTestClient = Parameters<typeof signFreighterXdr>[0]["freighter"];

function freighterMock(overrides?: {
  isConnected?: ReturnType<typeof vi.fn>;
  getNetwork?: ReturnType<typeof vi.fn>;
  signTransaction?: ReturnType<typeof vi.fn>;
}): NonNullable<FreighterTestClient> & {
  isConnected: ReturnType<typeof vi.fn>;
  getNetwork: ReturnType<typeof vi.fn>;
  signTransaction: ReturnType<typeof vi.fn>;
} {
  return {
    isConnected: overrides?.isConnected ?? vi.fn().mockResolvedValue({ isConnected: true }),
    getNetwork:
      overrides?.getNetwork ??
      vi.fn().mockResolvedValue({ network: "TESTNET", networkPassphrase: EXPECTED_PASSPHRASE }),
    signTransaction:
      overrides?.signTransaction ??
      vi.fn().mockResolvedValue({ signedTxXdr: "SIGNED_XDR", signerAddress: "GABC" }),
  } as never;
}

describe("signFreighterXdr", () => {
  it("returns ok with signed XDR on success", async () => {
    const result = await signFreighterXdr({
      unsignedXdr: "UNSIGNED",
      expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
      freighter: freighterMock(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signedXdr).toBe("SIGNED_XDR");
      expect(result.signerAddress).toBe("GABC");
    }
  });

  it("flags missing extension when isConnected reports false", async () => {
    const freighter = freighterMock({
      isConnected: vi.fn().mockResolvedValue({ isConnected: false }),
    });

    const result = await signFreighterXdr({
      unsignedXdr: "UNSIGNED",
      expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
      freighter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing");
    }
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it("flags passphrase mismatch before signing", async () => {
    const freighter = freighterMock({
      getNetwork: vi.fn().mockResolvedValue({
        network: "PUBLIC",
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      }),
    });

    const result = await signFreighterXdr({
      unsignedXdr: "UNSIGNED",
      expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
      freighter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("passphrase_mismatch");
    }
    expect(freighter.signTransaction).not.toHaveBeenCalled();
  });

  it("flags user rejection from signTransaction error payload", async () => {
    const freighter = freighterMock({
      signTransaction: vi.fn().mockResolvedValue({
        signedTxXdr: "",
        signerAddress: "",
        error: { code: -3, message: "User declined access" },
      }),
    });

    const result = await signFreighterXdr({
      unsignedXdr: "UNSIGNED",
      expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
      freighter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rejected");
    }
  });

  it("flags user rejection when signTransaction throws cancel-like error", async () => {
    const freighter = freighterMock({
      signTransaction: vi.fn().mockRejectedValue(new Error("Request was rejected by the user")),
    });

    const result = await signFreighterXdr({
      unsignedXdr: "UNSIGNED",
      expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
      freighter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rejected");
    }
  });

  it("flags invalid key when signer differs from source public key", async () => {
    const freighter = freighterMock({
      signTransaction: vi
        .fn()
        .mockResolvedValue({ signedTxXdr: "SIGNED_XDR", signerAddress: "GOTHER" }),
    });

    const result = await signFreighterXdr({
      unsignedXdr: "UNSIGNED",
      expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
      sourcePublicKey: "GABC",
      freighter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_key");
    }
  });

  it("falls back to unknown for unrecognized errors", async () => {
    const freighter = freighterMock({
      signTransaction: vi.fn().mockRejectedValue(new Error("Some internal RPC failure")),
    });

    const result = await signFreighterXdr({
      unsignedXdr: "UNSIGNED",
      expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
      freighter,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown");
      expect(result.message).toContain("Some internal RPC failure");
    }
  });
});
