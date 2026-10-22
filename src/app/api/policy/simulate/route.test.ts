import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/paths", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage/paths")>("@/lib/storage/paths");
  const dir = `/tmp/fortexa-simulate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    ...actual,
    getFortexaStoreDir: () => dir,
    getFortexaStorePath: (fileName: string) => path.join(dir, fileName),
    resolveContainedStorePath: (fileName: string) =>
      actual.resolveContainedStorePath(fileName, dir),
  };
});

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { POST } from "@/app/api/policy/simulate/route";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import {
  appendAuditEntry,
  consumeUsage,
  getDailyUsage,
  listAuditEntries,
} from "@/lib/storage/audit-store";
import { getPolicyConfig, updatePolicyConfig } from "@/lib/storage/policy-store";
import type { SimulationReport } from "@/lib/decision/simulate";
import type { PolicyConfig } from "@/lib/types/domain";

const USER_ID = "simulate-route-user";

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: USER_ID,
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

// Proposed policy raising the caps high enough to flip the over-budget scenario.
const proposedPolicy: PolicyConfig = {
  ...defaultPolicyConfig,
  perTxCapXLM: 100000,
  dailyCapXLM: 1000000,
  allowedHours: { start: 0, end: 23 },
};

type SimulateBody = {
  report: SimulationReport;
  auditSampled: number;
  error?: string;
};

describe("/api/policy/simulate route", () => {
  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/policy/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: proposedPolicy }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("rejects an invalid policy payload", async () => {
    const request = new NextRequest("http://localhost/api/policy/simulate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie() },
      body: JSON.stringify({ policy: { perTxCapXLM: 10 } }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("returns current-vs-proposed comparison without mutating state", async () => {
    const cookie = operatorCookie();

    // Seed known policy + usage + audit state to detect any mutation.
    await updatePolicyConfig(defaultPolicyConfig, USER_ID);
    await consumeUsage(USER_ID, 25);
    await appendAuditEntry(USER_ID, {
      id: "sim-audit-seed",
      timestamp: new Date().toISOString(),
      action: {
        id: "sim-audit-action",
        name: "Seed audit payment",
        kind: "api_payment",
        target: "research-pro:query",
        domain: "api.safe-research.ai",
        amountXLM: 12,
        tool: "research-pro",
      },
      decision: "APPROVE",
      explanation: "seed",
      triggeredPolicies: [],
      riskFindings: [],
    });

    const policyBefore = await getPolicyConfig();
    const usageBefore = await getDailyUsage(USER_ID);
    const auditCountBefore = (await listAuditEntries(USER_ID)).length;

    const request = new NextRequest("http://localhost/api/policy/simulate", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ policy: proposedPolicy, includeAudit: true }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as SimulateBody;

    // Comparison output present and shaped correctly.
    expect(payload.report.summary.total).toBe(payload.report.cases.length);
    const overBudget = payload.report.cases.find((c) => c.id === "scenario:over-budget-transfer");
    expect(overBudget?.current.decision).toBe("REQUIRE_APPROVAL");
    expect(overBudget?.proposed.decision).not.toBe("REQUIRE_APPROVAL");
    expect(overBudget?.changed).toBe(true);

    // Recent audit sample was included.
    expect(payload.auditSampled).toBeGreaterThanOrEqual(1);
    expect(payload.report.cases.some((c) => c.source === "audit")).toBe(true);

    // No persistence: policy version, usage, and audit history are unchanged.
    const policyAfter = await getPolicyConfig();
    const usageAfter = await getDailyUsage(USER_ID);
    const auditCountAfter = (await listAuditEntries(USER_ID)).length;

    expect(policyAfter.version).toBe(policyBefore.version);
    expect(policyAfter.policy.perTxCapXLM).toBe(policyBefore.policy.perTxCapXLM);
    expect(usageAfter.spentXLM).toBe(usageBefore.spentXLM);
    expect(usageAfter.toolCalls).toBe(usageBefore.toolCalls);
    expect(auditCountAfter).toBe(auditCountBefore);
  });
});
