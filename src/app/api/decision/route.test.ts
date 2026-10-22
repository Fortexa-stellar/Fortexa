import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getUserWalletMock, evaluateDecisionMock } = vi.hoisted(() => ({
  getUserWalletMock: vi.fn(),
  evaluateDecisionMock: vi.fn(),
}));

vi.mock("@/lib/storage/user-wallet-store", () => ({
  getUserWallet: getUserWalletMock,
}));
vi.mock("@/lib/decision/engine", () => ({
  evaluateDecision: evaluateDecisionMock,
}));

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { buildSecurityHeaders } from "@/lib/security/headers";
import { POST } from "@/app/api/decision/route";
import { getUserWallet } from "@/lib/storage/user-wallet-store";

beforeEach(() => {
  vi.mocked(evaluateDecisionMock).mockResolvedValue({
    decision: "APPROVE",
    explanation: "approved",
    riskScore: 0,
    triggeredPolicies: [],
    riskFindings: [],
    requiresManualApproval: false,
    analyzerStatus: { isDegraded: false },
  });
  vi.mocked(getUserWallet).mockResolvedValue({
    userId: "decision-operator-id",
    publicKey: `G${"A".repeat(55)}`,
    source: "external",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: "decision-operator-id",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function viewerCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "viewer@fortexa.local",
    role: "viewer",
    userId: "decision-viewer-id",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

describe("/api/decision route", () => {
  it.each([
    0,
    -1,
    1.00000001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ] as const)("rejects invalid amount %s before evaluation", async (amount) => {
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: JSON.stringify({
        action: {
          id: "action-invalid-amount",
          name: "Invalid payment",
          kind: "api_payment",
          target: "svc:endpoint",
          domain: "api.example.com",
          amountXLM: amount,
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(response.headers.get(key)).toBe(value);
    }
    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Invalid decision request body.");
  });

  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenarioId: "safe-research-payment" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(response.headers.get(key)).toBe(value);
    }
  });

  it("returns 403 for viewer role (operator-only route)", async () => {
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie(),
      },
      body: JSON.stringify({ scenarioId: "safe-research-payment" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(response.headers.get(key)).toBe(value);
    }
  });

  it("rejects decisions after the session wallet mapping is revoked", async () => {
    vi.mocked(getUserWallet).mockResolvedValueOnce(null);
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: JSON.stringify({ scenarioId: "safe-research-payment" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "No active wallet mapping found for this user.",
    });
  });

  it("rejects decisions after the session wallet mapping is revoked", async () => {
    vi.mocked(getUserWallet).mockResolvedValueOnce(null);
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: JSON.stringify({ scenarioId: "safe-research-payment" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: "No active wallet mapping found for this user.",
    });
  });

  it("evaluates scenario for operator", async () => {
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: JSON.stringify({ scenarioId: "safe-research-payment" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    for (const [key, value] of Object.entries(buildSecurityHeaders())) {
      expect(response.headers.get(key)).toBe(value);
    }
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const payload = (await response.json()) as {
      result: { decision: string; riskScore: number };
      userId: string;
    };

    expect(payload.userId).toBe("decision-operator-id");
    expect(typeof payload.result.decision).toBe("string");
    expect(typeof payload.result.riskScore).toBe("number");
  });
});
