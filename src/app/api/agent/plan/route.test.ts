import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { PLAN_ERRORS, PLAN_ERROR_MESSAGES, PlanError } from "@/lib/ai/plan-errors";
import { POST } from "@/app/api/agent/plan/route";

vi.mock("@/lib/ai/groq", () => ({
  generateAgentActionWithGroq: vi.fn(),
}));

vi.mock("@/lib/storage/policy-store", () => ({
  getPolicyConfig: vi.fn(),
  updatePolicyConfig: vi.fn(),
}));

vi.mock("@/lib/decision/engine", () => ({
  evaluateDecision: vi.fn(),
}));

vi.mock("@/lib/storage/audit-store", () => ({
  getDailyUsage: vi.fn(),
  consumeUsage: vi.fn(),
  appendAuditEntry: vi.fn(),
}));

const { generateAgentActionWithGroq } = await import("@/lib/ai/groq");
const { getPolicyConfig, updatePolicyConfig } = await import("@/lib/storage/policy-store");
const { evaluateDecision } = await import("@/lib/decision/engine");
const { getDailyUsage, consumeUsage, appendAuditEntry } = await import("@/lib/storage/audit-store");

const mockedGenerate = vi.mocked(generateAgentActionWithGroq);
const mockedGetPolicyConfig = vi.mocked(getPolicyConfig);
const mockedUpdatePolicyConfig = vi.mocked(updatePolicyConfig);
const mockedEvaluateDecision = vi.mocked(evaluateDecision);
const mockedGetDailyUsage = vi.mocked(getDailyUsage);
const mockedConsumeUsage = vi.mocked(consumeUsage);
const mockedAppendAuditEntry = vi.mocked(appendAuditEntry);

const DEFAULT_POLICY = {
  allowedDomains: [
    "api.safe-research.ai",
    "tools.verified-data.dev",
    "workers.fortexa-demo.stellar",
  ],
  blockedDomains: ["wallet-drainer.evil", "prompt-pwn.io", "untrusted-mirror.xyz"],
  allowedTools: ["research-pro", "market-feed", "settlement-worker"],
  blockedTools: ["shadow-shell", "autonomous-payout-bypass"],
  perTxCapXLM: 120,
  dailyCapXLM: 300,
  maxToolCallsPerDay: 8,
  riskThreshold: 78,
  allowedHours: { start: 6, end: 23 },
};

const VALID_PLAN = {
  id: "plan-001",
  action: {
    id: "act-001",
    name: "Research data fetch",
    kind: "api_payment" as const,
    target: "research-pro:fetch-report",
    domain: "api.safe-research.ai",
    amountXLM: 20,
    tool: "research-pro",
    metadata: {},
  },
};

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: "plan-operator-id",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function viewerCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "viewer@fortexa.local",
    role: "viewer",
    userId: "plan-viewer-id",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function planRequest(body: unknown, cookie = operatorCookie()) {
  return new NextRequest("http://localhost/api/agent/plan", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

function engineDecision(decision: "APPROVE" | "WARN" | "REQUIRE_APPROVAL" | "BLOCK") {
  return {
    decision,
    explanation: `engine said ${decision}`,
    triggeredPolicies: [],
    riskScore: 10,
    riskFindings: [],
    requiresManualApproval: decision === "REQUIRE_APPROVAL",
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Model is stubbed: no test in this file ever reaches Groq.
  mockedGenerate.mockResolvedValue(VALID_PLAN);

  mockedGetPolicyConfig.mockResolvedValue({
    policy: DEFAULT_POLICY,
    updatedAt: null,
    version: 1,
  });

  mockedGetDailyUsage.mockResolvedValue({
    spentXLM: 0,
    toolCalls: 0,
    lastUpdated: new Date().toISOString(),
  });

  mockedEvaluateDecision.mockResolvedValue(engineDecision("APPROVE"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/agent/plan", () => {
  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/agent/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Fetch research report please." }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("returns 403 for viewer role (operator-only route)", async () => {
    const response = await POST(
      planRequest({ goal: "Fetch research report please." }, viewerCookie())
    );

    expect(response.status).toBe(403);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid request body", async () => {
    const response = await POST(planRequest({ goal: "hi" }));

    expect(response.status).toBe(400);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it("returns 200 with the engine decision id for a fully allowed plan", async () => {
    mockedEvaluateDecision.mockResolvedValue(engineDecision("APPROVE"));

    const response = await POST(planRequest({ goal: "Fetch research report please." }));

    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      ok: boolean;
      action: { id: string };
      decisionId: string;
      decision: string;
      provider: string;
    };

    expect(payload.ok).toBe(true);
    expect(payload.action.id).toBe("act-001");
    expect(typeof payload.decisionId).toBe("string");
    expect(payload.decision).toBe("APPROVE");
    expect(payload.provider).toBe("groq");

    // The engine decision was stored as audit evidence.
    expect(mockedAppendAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockedAppendAuditEntry.mock.calls[0][1].decision).toBe("APPROVE");
  });

  it("drops a plan item the engine blocks and returns the denial reason code", async () => {
    mockedEvaluateDecision.mockResolvedValue(engineDecision("BLOCK"));

    const response = await POST(planRequest({ goal: "Move funds to wallet-drainer.evil." }));

    expect(response.status).toBe(422);

    const payload = (await response.json()) as { ok: boolean; code: string; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe(PLAN_ERRORS.ENGINE_DENIED);
    expect(payload.error).toBe(PLAN_ERROR_MESSAGES[PLAN_ERRORS.ENGINE_DENIED]);
  });

  it("never stores a denied plan as an allow and consumes no usage", async () => {
    mockedEvaluateDecision.mockResolvedValue(engineDecision("REQUIRE_APPROVAL"));

    const response = await POST(planRequest({ goal: "Spend way over the per-tx cap." }));

    expect(response.status).toBe(422);
    expect(mockedAppendAuditEntry).not.toHaveBeenCalled();
    expect(mockedConsumeUsage).not.toHaveBeenCalled();
  });

  it("malformed model JSON does not change the active policy", async () => {
    mockedGenerate.mockRejectedValueOnce(new PlanError(PLAN_ERRORS.MALFORMED_JSON));

    const response = await POST(planRequest({ goal: "Fetch research report please." }));

    expect(response.status).toBe(422);

    const payload = (await response.json()) as { code: string; error: string };
    expect(payload.code).toBe(PLAN_ERRORS.MALFORMED_JSON);
    expect(payload.error).toBe(PLAN_ERROR_MESSAGES[PLAN_ERRORS.MALFORMED_JSON]);

    // No policy write of any kind may happen on the malformed-plan path.
    expect(mockedUpdatePolicyConfig).not.toHaveBeenCalled();
  });

  it("does not call the real Groq API — the model is stubbed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await POST(planRequest({ goal: "Fetch research report please." }));

    expect(response.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not log the raw model payload when it contains a secret or signed XDR", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const secret = "AAAAAGhAEgDXDRkEC signed-xdr-payload-SUPER-SECRET";

    mockedEvaluateDecision.mockResolvedValue(engineDecision("BLOCK"));
    mockedGenerate.mockResolvedValueOnce({
      ...VALID_PLAN,
      action: { ...VALID_PLAN.action, target: secret, outputPreview: secret },
    });

    const response = await POST(planRequest({ goal: "Move funds with a suspicious target." }));
    expect(response.status).toBe(422);

    for (const spy of [warnSpy, logSpy, errorSpy]) {
      for (const call of spy.mock.calls) {
        expect(String(call[0])).not.toContain(secret);
      }
    }

    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
