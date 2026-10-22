import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPolicyConfig } from "@/lib/policy/engine";
import type { AuditEntry, PolicyConfig } from "@/lib/types/domain";

// ---- shared fixture used by both routes ----
const activePolicy: PolicyConfig = {
  ...defaultPolicyConfig,
  allowedHours: undefined,
  perTxCapXLM: 250,
};
const conflictingCandidate: PolicyConfig = { ...activePolicy, perTxCapXLM: 20 };
const cleanCandidate: PolicyConfig = { ...activePolicy, perTxCapXLM: 200 };

const DESTINATION = "GDESTINATIONSHOULDNEVERAPPEARINTHECONFLICTLIST0000000000";

function inFlightAllow(
  id: string,
  amountXLM: number,
  overrides: Partial<AuditEntry> = {}
): AuditEntry {
  return {
    id,
    timestamp: "2026-09-01T00:00:00.000Z",
    action: {
      id: `act-${id}`,
      name: "Pay verified research API",
      kind: "api_payment",
      target: "research-pro:query/alpha",
      domain: "api.safe-research.ai",
      amountXLM,
      tool: "research-pro",
    },
    decision: "APPROVE",
    explanation: "approved",
    triggeredPolicies: [],
    riskFindings: [],
    paymentQuote: {
      destination: DESTINATION,
      amountXLM: String(amountXLM),
      asset: "native",
      memo: `fortexa:${id}`,
      network: "testnet",
    } as AuditEntry["paymentQuote"],
    ...overrides,
  };
}

const auditFixture: Record<string, AuditEntry[]> = {
  "user-a": [
    inFlightAllow("pay-large", 50),
    inFlightAllow("pay-small", 5),
    inFlightAllow("pay-submitted", 90, { stellarTxHash: "abc" }),
    inFlightAllow("pay-blocked", 90, { decision: "BLOCK" }),
  ],
};

const policyVersions: Record<number, PolicyConfig> = { 1: conflictingCandidate, 2: cleanCandidate };
let active = { policy: activePolicy, version: 3 };

const rollbackPolicyVersion = vi.fn(async (targetVersion: number) => {
  active = { policy: policyVersions[targetVersion], version: active.version + 1 };
  return { policy: active.policy, version: active.version, updatedAt: "now" };
});

vi.mock("@/lib/storage/policy-store", () => ({
  getPolicyConfig: vi.fn(async () => active),
  getPolicyVersionByNumber: vi.fn(async (targetVersion: number) => {
    const policy = policyVersions[targetVersion];
    if (!policy) throw new Error(`Policy version ${targetVersion} not found.`);
    return { version: targetVersion, updatedAt: "then", policy };
  }),
  rollbackPolicyVersion: (targetVersion: number) => rollbackPolicyVersion(targetVersion),
}));

vi.mock("@/lib/storage/audit-store", () => ({
  listAllAuditEntriesByUser: vi.fn(async () => auditFixture),
  listAuditEntries: vi.fn(async () => []),
  getDailyUsage: vi.fn(async () => ({
    spentXLM: 0,
    toolCalls: 0,
    lastUpdated: "2026-09-01T00:00:00.000Z",
  })),
}));

vi.mock("@/lib/security/analyzer", () => ({
  evaluateSecurity: vi.fn(async () => ({
    riskScore: 10,
    findings: [],
    analyzerStatus: { blocklistStatus: "success", isDegraded: false, degradationReasons: [] },
  })),
}));

import { POST as previewPOST } from "@/app/api/policy/rollback/preview/route";
import { POST as rollbackPOST } from "@/app/api/policy/rollback/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { findRollbackConflicts, type RollbackConflict } from "@/lib/decision/rollback-conflicts";

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "rollback-conflicts-test-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: "rollback-conflicts-operator",
    expiresInSeconds: 120,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function post(path: string, targetVersion: number) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: operatorCookie() },
    body: JSON.stringify({ targetVersion }),
  });
}

async function preview(targetVersion: number) {
  const response = await previewPOST(post("/api/policy/rollback/preview", targetVersion));
  return {
    status: response.status,
    body: (await response.json()) as { conflicts: RollbackConflict[] },
  };
}

async function rollback(targetVersion: number) {
  const response = await rollbackPOST(post("/api/policy/rollback", targetVersion));
  return {
    status: response.status,
    body: (await response.json()) as { conflicts?: RollbackConflict[]; version?: number },
  };
}

describe("rollback preview and rollback share one conflict check", () => {
  beforeEach(() => {
    active = { policy: activePolicy, version: 3 };
    rollbackPolicyVersion.mockClear();
  });

  it("lists a conflicting in-flight allow in preview and rollback rejects the same ids", async () => {
    const previewed = await preview(1);
    expect(previewed.status).toBe(200);
    expect(previewed.body.conflicts).toEqual([
      {
        paymentId: "pay-large",
        ruleIds: ["PER_TX_CAP_EXCEEDED"],
        reasonCode: "ROLLBACK_WOULD_REQUIRE_APPROVAL",
      },
    ]);

    const rejected = await rollback(1);
    expect(rejected.status).toBe(409);
    expect(rejected.body.conflicts).toEqual(previewed.body.conflicts);
    expect(rollbackPolicyVersion).not.toHaveBeenCalled();
    expect(active.policy).toBe(activePolicy);
  });

  it("preview does not change the active policy", async () => {
    await preview(1);
    await preview(2);
    expect(active).toEqual({ policy: activePolicy, version: 3 });
    expect(rollbackPolicyVersion).not.toHaveBeenCalled();
  });

  it("a clean candidate lists no conflicts and rollback applies it", async () => {
    const previewed = await preview(2);
    expect(previewed.status).toBe(200);
    expect(previewed.body.conflicts).toEqual([]);

    const applied = await rollback(2);
    expect(applied.status).toBe(200);
    expect(rollbackPolicyVersion).toHaveBeenCalledWith(2);
    expect(active.policy).toBe(cleanCandidate);
  });

  it("redacts conflicts down to ids", async () => {
    const previewed = await preview(1);
    const serialized = JSON.stringify(previewed.body.conflicts);
    expect(serialized).not.toContain(DESTINATION);
    expect(serialized).not.toContain("api.safe-research.ai");
    expect(Object.keys(previewed.body.conflicts[0]).sort()).toEqual([
      "paymentId",
      "reasonCode",
      "ruleIds",
    ]);
  });

  it("route output matches the shared function for the same fixture", async () => {
    const direct = findRollbackConflicts({
      candidatePolicy: conflictingCandidate,
      entries: Object.values(auditFixture).flat(),
    });
    expect((await preview(1)).body.conflicts).toEqual(direct);
    expect((await rollback(1)).body.conflicts).toEqual(direct);
  });
});
