import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "./route";

// Real observability stack: the route logs through logger.ts, which must
// redact via redactSensitiveFields before console output (issue #205).
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

vi.mock("@/lib/storage/user-wallet-store", () => ({
  getUserWallet: vi.fn().mockResolvedValue({
    userId: "redaction-decision-operator-id",
    publicKey: "GA7QYNF7SOWQ3GLR2ZGMGIRKJ7F6NCWKUX6PS7LJVCUJUJQG2U5F6Z7P",
    source: "external",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  isUserWalletRevoked: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/lib/decision/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/decision/engine")>();
  return {
    ...actual,
    evaluateDecision: vi.fn(actual.evaluateDecision),
  };
});

const { evaluateDecision } = await import("@/lib/decision/engine");
const { AUTH_COOKIE_KEY, createSessionToken } = await import("@/lib/auth/session");
const metrics = await import("@/lib/observability/metrics");

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "redaction-operator@fortexa.local",
    role: "operator",
    userId: "redaction-decision-operator-id",
    expiresInSeconds: 120,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function postDecision(body: unknown) {
  return new NextRequest("http://localhost/api/decision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: operatorCookie(),
    },
    body: JSON.stringify(body),
  });
}

const TEST_DESTINATION = "GA7QYNF7SOWQ3GLR2ZGMGIRKJ7F6NCWKUX6PS7LJVCUJUJQG2U5F6Z7P";
const SIGNED_XDR_BLOB =
  "AAAAAgAAAABb9mDlFqQbGUnkl4S5jgY6b0jI9kUhF1cVzYfVJB1XgAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABjX2WdAAAAAAAAAAEAAAAAAAAAAAAAAABjX2WdAAAAAQAAAA";

describe("/api/decision observability redaction", () => {
  beforeEach(() => {
    consoleErrorSpy.mockClear();
    consoleWarnSpy.mockClear();
    vi.mocked(evaluateDecision).mockClear();
    metrics.resetMetrics();
  });

  it("redacts destination, memo, XDR, and API keys from validation-failure logs", async () => {
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: `{ "paymentQuoteInput": { "destination": "${TEST_DESTINATION}", "memo": "wire-8817", "network": "TESTNET" }, "signedXdr": "${SIGNED_XDR_BLOB}", "apiKey": "sk-live-abcdef" }`,
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const loggedLines = [
      ...consoleWarnSpy.mock.calls.flat().map(String),
      ...consoleErrorSpy.mock.calls.flat().map(String),
    ];
    expect(loggedLines.length).toBeGreaterThan(0);
    for (const line of loggedLines) {
      expect(line).not.toContain(TEST_DESTINATION);
      expect(line).not.toContain("wire-8817");
      expect(line).not.toContain(SIGNED_XDR_BLOB);
      expect(line).not.toContain("sk-live-abcdef");
    }
  });

  it("redacts secrets when the decision route throws an internal error", async () => {
    vi.mocked(evaluateDecision).mockRejectedValueOnce(
      new Error(`ledger write failed for ${TEST_DESTINATION} (api_key=sk-live-zzz)`)
    );

    const response = await POST(postDecision({ scenarioId: "safe-research-payment" }));
    expect(response.status).toBe(500);

    const serialized = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(serialized).toContain("Decision route internal error");
    expect(serialized).not.toContain(TEST_DESTINATION);
    expect(serialized).not.toContain("sk-live-zzz");
    expect(serialized).toContain("api_key=[REDACTED]");
  });

  it("keeps decision outcome metrics incrementing alongside redacted logging", async () => {
    const response = await POST(postDecision({ scenarioId: "safe-research-payment" }));
    expect(response.status).toBe(200);

    const counts = metrics.getDecisionOutcomeCounts();
    const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it("still records the API error metric when an internal error is redacted", async () => {
    vi.mocked(evaluateDecision).mockRejectedValueOnce(new Error(`boom ${TEST_DESTINATION}`));

    const response = await POST(postDecision({ scenarioId: "safe-research-payment" }));
    expect(response.status).toBe(500);

    const snapshot = metrics.getMetricsSnapshot();
    const decisionRoute = snapshot.routes.find((r) => r.route === "/api/decision");
    expect(decisionRoute).toBeDefined();
    expect(decisionRoute?.errorCount).toBeGreaterThanOrEqual(1);
    expect(decisionRoute?.lastStatusCode).toBe(500);
  });
});
