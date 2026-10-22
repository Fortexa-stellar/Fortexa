import { Networks } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(() => ({ ok: true, session: { userId: "operator-1" } })),
}));
vi.mock("@/lib/auth/session-wallet", () => ({
  getWalletFromSession: vi.fn(() => "GTESTWALLET"),
}));
vi.mock("@/lib/observability/logger", () => ({
  getRequestLogContext: vi.fn(() => ({ requestId: "request-1", route: "/api/stellar/setup" })),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/security/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));
vi.mock("@/lib/stellar/network-config", () => ({
  getStellarNetworkPassphrase: vi.fn(() => Networks.TESTNET),
}));
vi.mock("@/lib/storage/user-wallet-store", () => ({
  getUserWallet: vi.fn(async () => null),
  upsertUserWallet: vi.fn(async () => undefined),
}));
vi.mock("@/lib/validation/schemas", () => ({
  stellarSetupRequestSchema: { safeParse: vi.fn(() => ({ success: true, data: {} })) },
}));
vi.mock("@/lib/validation/errors", () => ({
  logValidationFailure: vi.fn(),
  toPublicValidationDetails: vi.fn(() => []),
}));

import { getStellarNetworkPassphrase } from "@/lib/stellar/network-config";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";
import { logWarn } from "@/lib/observability/logger";

function buildRequest() {
  return new NextRequest("http://localhost/api/stellar/setup", {
    method: "POST",
    body: JSON.stringify({}),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/stellar/setup network guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses the public network before syncing the wallet and returns no secret", async () => {
    vi.mocked(getStellarNetworkPassphrase).mockReturnValue(Networks.PUBLIC);

    const response = await POST(buildRequest());
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).toBe(
      JSON.stringify({ error: "Stellar setup is disabled on the public network." })
    );
    expect(upsertUserWallet).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      "Stellar setup refused on public network",
      expect.objectContaining({ route: "/api/stellar/setup" })
    );
  });

  it("continues through the existing testnet wallet-sync path", async () => {
    vi.mocked(getStellarNetworkPassphrase).mockReturnValue(Networks.TESTNET);

    const response = await POST(buildRequest());

    expect(response.status).toBe(200);
    expect(upsertUserWallet).toHaveBeenCalledWith(
      "operator-1",
      expect.objectContaining({
        publicKey: "GTESTWALLET",
      })
    );
    expect(logWarn).not.toHaveBeenCalled();
  });
});
