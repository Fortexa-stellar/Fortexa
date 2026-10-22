import { Networks } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(() => ({ ok: true, session: { userId: "operator-1" } })),
}));
vi.mock("@/lib/observability/logger", () => ({
  getRequestLogContext: vi.fn(() => ({ requestId: "request-1", route: "/api/stellar/fund" })),
  logWarn: vi.fn(),
}));
vi.mock("@/lib/stellar/network-config", () => ({
  getStellarNetworkPassphrase: vi.fn(() => Networks.TESTNET),
}));

import { getStellarNetworkPassphrase } from "@/lib/stellar/network-config";
import { logWarn } from "@/lib/observability/logger";

function buildRequest() {
  return new NextRequest("http://localhost/api/stellar/fund", { method: "POST" });
}

describe("POST /api/stellar/fund network guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses the public network with a stable secret-free error", async () => {
    vi.mocked(getStellarNetworkPassphrase).mockReturnValue(Networks.PUBLIC);

    const response = await POST(buildRequest());
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).toBe(
      JSON.stringify({ error: "Stellar funding is disabled on the public network." })
    );
    expect(logWarn).toHaveBeenCalledWith(
      "Stellar funding refused on public network",
      expect.objectContaining({ route: "/api/stellar/fund" })
    );
  });

  it("preserves the removed-funding response on testnet", async () => {
    vi.mocked(getStellarNetworkPassphrase).mockReturnValue(Networks.TESTNET);

    const response = await POST(buildRequest());
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.error).toBe("Friendbot funding has been removed from this project.");
    expect(logWarn).not.toHaveBeenCalled();
  });
});
