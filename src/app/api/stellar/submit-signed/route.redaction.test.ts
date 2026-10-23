import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "./route";

// Route-level regression for #205: a Horizon/submit failure whose error
// message carries the signed XDR envelope, the destination address, a memo
// value, and an API key must be redacted before it reaches the log line,
// while the stable horizon_failure counter still increments.
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/readiness/production", () => ({
  getProtectedPaymentFlowReadinessReport: vi.fn(() => null),
}));

vi.mock("@/lib/http/read-json-body", () => ({
  readJsonBody: vi.fn(async () => ({ ok: true as const, data: { signedXdr: "A".repeat(40) } })),
}));

vi.mock("@/lib/storage/submit-idempotency-store", () => ({
  getIdempotencyRecord: vi.fn(),
  hashSignedXdr: vi.fn(() => "hash"),
  maybeRunCleanup: vi.fn(),
  putIdempotencyRecord: vi.fn(),
}));

vi.mock("@/lib/storage/user-wallet-store", () => ({
  getUserWallet: vi.fn(),
}));

import { requireAuth } from "@/lib/auth/require-auth";
import { getUserWallet } from "@/lib/storage/user-wallet-store";
import { getStellarSubmitResultCounts, resetMetrics } from "@/lib/observability/metrics";

const TEST_DESTINATION = "GA7QYNF7SOWQ3GLR2ZGMGIRKJ7F6NCWKUX6PS7LJVCUJUJQG2U5F6Z7P";
const SIGNED_XDR_BLOB =
  "AAAAAgAAAABb9mDlFqQbGUnkl4S5jgY6b0jI9kUhF1cVzYfVJB1XgAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABjX2WdAAAAAAAAAAEAAAAAAAAAAAAAAABjX2WdAAAAAQAAAA==";

function submitRequest() {
  return new NextRequest("http://localhost/api/stellar/submit-signed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: "A".repeat(40) }),
  });
}

describe("/api/stellar/submit-signed observability redaction", () => {
  beforeEach(() => {
    consoleErrorSpy.mockClear();
    vi.mocked(requireAuth).mockReturnValue({
      ok: true,
      session: { userId: "submit-redaction-user" },
    } as ReturnType<typeof requireAuth>);
    resetMetrics();
  });

  it("redacts signed XDR, destination, memo, and api_key from submit failure logs", async () => {
    vi.mocked(getUserWallet).mockRejectedValueOnce(
      new Error(
        `horizon rejected envelope ${SIGNED_XDR_BLOB} for ${TEST_DESTINATION} (memo=wire-8817, api_key=sk-live-abc123)`
      )
    );

    const response = await POST(submitRequest());
    expect(response.status).toBe(500);

    const serialized = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(serialized).toContain("Submit signed internal error");
    expect(serialized).not.toContain(SIGNED_XDR_BLOB);
    expect(serialized).not.toContain(TEST_DESTINATION);
    expect(serialized).not.toContain("wire-8817");
    expect(serialized).not.toContain("sk-live-abc123");
    expect(serialized).toContain("api_key=[REDACTED]");
    expect(serialized).toContain("memo=[REDACTED]");
  });

  it("still increments the horizon_failure counter when the error is fully redacted", async () => {
    const fullyRedactable = `submit failed: ${SIGNED_XDR_BLOB}`;

    vi.mocked(getUserWallet).mockRejectedValueOnce(new Error(fullyRedactable));

    const response = await POST(submitRequest());
    expect(response.status).toBe(500);

    const counts = getStellarSubmitResultCounts();
    expect(counts.get("horizon_failure")).toBe(1);
  });

  it("does not echo secret-bearing detail into non-error log levels", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    vi.mocked(getUserWallet).mockRejectedValueOnce(
      new Error(`payment to ${TEST_DESTINATION} failed (memo=invoice-42)`)
    );

    await POST(submitRequest());

    for (const line of [
      ...consoleWarnSpy.mock.calls.flat().map(String),
      ...consoleInfoSpy.mock.calls.flat().map(String),
    ]) {
      expect(line).not.toContain(TEST_DESTINATION);
      expect(line).not.toContain("invoice-42");
    }

    consoleWarnSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });
});
