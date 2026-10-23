import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/storage/paths", () => {
  const dir = `/tmp/fortexa-history-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    getFortexaStoreDir: () => dir,
    getFortexaStorePath: (fileName: string) => path.join(dir, fileName),
  };
});

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { GET } from "@/app/api/policy/history/route";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import {
  appendAuditEntry,
  getDailyUsage,
  listAllAuditEntriesByUser,
} from "@/lib/storage/audit-store";
import {
  getPolicyConfig,
  getPolicyVersionByNumber,
  updatePolicyConfig,
} from "@/lib/storage/policy-store";
import { diffDecisionImpact, openAllowDecisions } from "@/lib/validation/diff";
import type { PolicyConfig } from "@/lib/types/domain";

const USER_ID = "policy-history-operator";

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

/** v2: plain default policy. */
const permissivePolicy: PolicyConfig = { ...defaultPolicyConfig };

/** v3: candidate that blocks a domain of a currently allowed payment. */
const blockingPolicy: PolicyConfig = {
  ...defaultPolicyConfig,
  allowedDomains: defaultPolicyConfig.allowedDomains.filter(
    (domain) => domain !== "api.safe-research.ai"
  ),
  blockedDomains: [...defaultPolicyConfig.blockedDomains, "api.safe-research.ai"],
};

/** v4 (active): differs from v2 only by a cap change that flips nothing. */
const activePolicy: PolicyConfig = { ...defaultPolicyConfig, dailyCapXLM: 999 };

type HistoryBody = {
  entries: Array<{ version: number }>;
  decisionImpact: {
    candidateVersion: number;
    activeVersion: number;
    flippedIds: string[];
    flips: Array<{ paymentId: string; ruleId: string; from: string; to: string }>;
    hasDecisionChange: boolean;
    status: "decision change" | "no decision change";
  } | null;
  error?: string;
};

async function historyRequest(query: string) {
  const request = new NextRequest(`http://localhost/api/policy/history${query}`, {
    method: "GET",
    headers: { cookie: operatorCookie() },
  });

  return GET(request);
}

describe("/api/policy/history route", () => {
  beforeAll(async () => {
    await updatePolicyConfig(permissivePolicy, USER_ID); // v2
    await updatePolicyConfig(blockingPolicy, USER_ID); // v3 (candidate that flips)
    await updatePolicyConfig(activePolicy, USER_ID); // v4 (active)

    await appendAuditEntry(USER_ID, {
      id: "payment-allow-1",
      timestamp: new Date().toISOString(),
      action: {
        id: "action-allow-1",
        name: "Allowed research payment",
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
  });

  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/policy/history", { method: "GET" });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns history for operator", async () => {
    const request = new NextRequest("http://localhost/api/policy/history?limit=3", {
      method: "GET",
      headers: { cookie: operatorCookie() },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as HistoryBody;
    expect(Array.isArray(payload.entries)).toBe(true);
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.decisionImpact).toBeNull();
  });

  it("lists the payment a candidate rule edit would flip, without activating it", async () => {
    const before = await getPolicyConfig();
    const response = await historyRequest("?limit=8&candidate=3");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as HistoryBody;
    expect(payload.decisionImpact).not.toBeNull();
    expect(payload.decisionImpact!.candidateVersion).toBe(3);
    expect(payload.decisionImpact!.activeVersion).toBe(before.version);
    expect(payload.decisionImpact!.status).toBe("decision change");
    expect(payload.decisionImpact!.hasDecisionChange).toBe(true);
    expect(payload.decisionImpact!.flippedIds).toEqual(["payment-allow-1"]);

    const flip = payload.decisionImpact!.flips[0];
    expect(flip.ruleId).toBe("blockedDomains[api.safe-research.ai]");
    expect(flip.to).toBe("BLOCK");
    expect(["APPROVE", "WARN"]).toContain(flip.from);

    // The read never activates the candidate.
    const after = await getPolicyConfig();
    expect(after.version).toBe(before.version);
    expect(after.policy).toEqual(before.policy);
  });

  it("reports no decision change when the candidate flips nothing", async () => {
    const response = await historyRequest("?candidate=2");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as HistoryBody;
    expect(payload.decisionImpact!.status).toBe("no decision change");
    expect(payload.decisionImpact!.hasDecisionChange).toBe(false);
    expect(payload.decisionImpact!.flippedIds).toEqual([]);
    expect(payload.decisionImpact!.flips).toEqual([]);
  });

  it("returns the same flipped ids as the diff helper", async () => {
    const { policy: activePolicyNow } = await getPolicyConfig();
    const candidate = await getPolicyVersionByNumber(3);
    const entriesByUser = await listAllAuditEntriesByUser();
    const decisions = openAllowDecisions(entriesByUser[USER_ID], await getDailyUsage(USER_ID));

    const helper = await diffDecisionImpact({
      activePolicy: activePolicyNow,
      candidatePolicy: candidate.policy,
      decisions,
    });

    const response = await historyRequest("?candidate=3");
    const payload = (await response.json()) as HistoryBody;

    expect(payload.decisionImpact!.flippedIds).toEqual(helper.flippedIds);
    expect(payload.decisionImpact!.flips.map((f) => f.ruleId)).toEqual(
      helper.flips.map((f) => f.ruleId)
    );
    expect(payload.decisionImpact!.status).toBe(helper.status);
  });

  it("rejects an invalid candidate version", async () => {
    const response = await historyRequest("?candidate=abc");
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown candidate version", async () => {
    const response = await historyRequest("?candidate=999");
    expect(response.status).toBe(404);
  });
});
