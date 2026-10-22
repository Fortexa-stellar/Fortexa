import { promises as fs } from "node:fs";

import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmpDir = `/tmp/fortexa-build-payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.FORTEXA_STORE_DIR = tmpDir;
  process.env.FORTEXA_AUTH_SECRET = "build-payment-test-secret";
  process.env.STELLAR_HORIZON_URL = "https://horizon-mock.test";
  delete process.env.DATABASE_URL;
});

const horizonMocks = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  fetchBaseFee: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");

  class MockServer {
    loadAccount(accountId: string) {
      return horizonMocks.loadAccount(accountId);
    }
    fetchBaseFee() {
      return horizonMocks.fetchBaseFee();
    }
  }

  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
  };
});

vi.mock("@/lib/decision/engine", () => ({
  evaluateDecision: vi.fn(async () => ({
    decision: "APPROVE",
    explanation: "Fixture decision",
    triggeredPolicies: [],
    riskScore: 0,
    riskFindings: [],
    requiresManualApproval: false,
    analyzerStatus: { isDegraded: false },
  })),
}));

import { Account } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";

import { POST as decisionPost } from "@/app/api/decision/route";
import { POST as buildPaymentPost } from "@/app/api/stellar/build-payment/route";
import { buildPaymentQuoteFromDecision } from "@/lib/stellar/verify-payment-quote";
import { getFortexaStorePath } from "@/lib/storage/paths";
import { decisionAmountStroops } from "@/lib/decision/engine";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import { resetAuditState } from "@/lib/storage/audit-store";
import { getPolicyConfig, updatePolicyConfig } from "@/lib/storage/policy-store";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";

const OPERATOR_USER_ID = "build-payment-operator";

const sourceKeypair = Keypair.random();
const destinationKeypair = Keypair.random();
const authorizedAmount = "18.0000000";
const authorizedMemo = "fortexa:act-safe-1";

function operatorCookie() {
  const token = createSessionToken({
    email: "build-payment@fortexa.local",
    role: "operator",
    userId: OPERATOR_USER_ID,
    expiresInSeconds: 300,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function signerCookie() {
  const token = createSessionToken({
    email: "signer@fortexa.local",
    role: "signer",
    userId: OPERATOR_USER_ID,
    expiresInSeconds: 300,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function jsonRequest(url: string, body: unknown, cookie = signerCookie()) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });
}

function authorizedBuildBody(overrides: Record<string, unknown> = {}) {
  return {
    auditEntryId: "",
    destination: destinationKeypair.publicKey(),
    amountXLM: authorizedAmount,
    asset: "native",
    memo: authorizedMemo,
    network: "testnet",
    ...overrides,
  };
}

let lastAuditEntryId = "";

async function seedAuthorizedPayment(amountXLM = 18) {
  const amountStroops = decisionAmountStroops(amountXLM);
  const quote = {
    ...buildPaymentQuoteFromDecision({
      destination: destinationKeypair.publicKey(),
      amountXLM,
      memo: authorizedMemo,
      actionId: "act-safe-1",
      network: "testnet",
    }),
    ...(amountStroops ? { amountStroops } : {}),
  };
  const entryId = "00000000-0000-4000-8000-000000000249";
  const store = {
    auditByUser: {
      [OPERATOR_USER_ID]: [
        {
          id: entryId,
          timestamp: new Date().toISOString(),
          action: {
            id: "act-safe-1",
            name: "Pay verified research API",
            kind: "api_payment",
            target: "research-pro:query/alpha",
            domain: "api.safe-research.ai",
            amountXLM,
            tool: "research-pro",
          },
          decision: "APPROVE",
          explanation: "Allowed at the policy cap.",
          triggeredPolicies: [],
          riskFindings: [],
          paymentQuote: quote,
        },
      ],
    },
    usageByUser: {},
  };
  await fs.writeFile(getFortexaStorePath("audit.json"), JSON.stringify(store), "utf8");
  lastAuditEntryId = entryId;
}

async function authorizePaymentDecision() {
  const decisionRes = await decisionPost(
    jsonRequest("http://localhost/api/decision", {
      scenarioId: "safe-research-payment",
      paymentQuoteInput: {
        destination: destinationKeypair.publicKey(),
        memo: authorizedMemo,
        network: "testnet",
      },
    })
  );
  expect(decisionRes.status).toBe(200);

  const payload = (await decisionRes.json()) as {
    auditEntry: { id: string; paymentQuote?: { destination: string } };
  };
  lastAuditEntryId = payload.auditEntry.id;
  return payload.auditEntry;
}

beforeAll(async () => {
  const { policy } = await getPolicyConfig();
  await updatePolicyConfig(
    {
      ...defaultPolicyConfig,
      ...policy,
      allowedHours: { start: 0, end: 23 },
    },
    "build-payment-test-setup"
  );

  await upsertUserWallet(OPERATOR_USER_ID, {
    publicKey: sourceKeypair.publicKey(),
    source: "external",
    provider: "freighter",
  });
});

afterAll(async () => {
  const storeDir = process.env.FORTEXA_STORE_DIR;
  if (storeDir && storeDir.startsWith("/tmp/fortexa-build-payment-")) {
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

beforeEach(async () => {
  horizonMocks.loadAccount.mockReset();
  horizonMocks.fetchBaseFee.mockReset();
  horizonMocks.loadAccount.mockImplementation(async (accountId: string) => {
    return new Account(accountId, "1234");
  });
  horizonMocks.fetchBaseFee.mockResolvedValue(100);

  await resetAuditState(OPERATOR_USER_ID);
  lastAuditEntryId = "";
});

describe("POST /api/stellar/build-payment quote verification", () => {
  it("rejects operator-only wallets", async () => {
    const response = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody(),
        operatorCookie()
      )
    );

    expect(response.status).toBe(403);
  });

  it.each(["0", "-1", "NaN", "Infinity", "9007199254740992", "10.12345678"] as const)(
    "rejects invalid amount %s before XDR construction",
    async (amount) => {
      const buildRes = await buildPaymentPost(
        jsonRequest(
          "http://localhost/api/stellar/build-payment",
          authorizedBuildBody({
            auditEntryId: "00000000-0000-4000-8000-000000000000",
            amountXLM: amount,
          })
        )
      );

      expect(buildRes.status).toBe(400);
      const payload = (await buildRes.json()) as {
        error: string;
        details?: { fieldErrors?: { amountXLM?: string[] } };
      };
      expect(payload.error).toBe("Invalid payment build request.");
      expect(payload.details?.fieldErrors?.amountXLM).toContain(
        "amountXLM must be a positive finite XLM amount with up to 7 decimals."
      );
      expect(horizonMocks.loadAccount).not.toHaveBeenCalled();
    }
  );

  it("builds XDR when request matches the authorized payment quote", async () => {
    await authorizePaymentDecision();

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody({ auditEntryId: lastAuditEntryId })
      )
    );

    expect(buildRes.status).toBe(200);
    const payload = (await buildRes.json()) as { ok: boolean; xdr: string };
    expect(payload.ok).toBe(true);
    expect(payload.xdr.length).toBeGreaterThan(20);
    expect(horizonMocks.loadAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
  });

  it("rejects tampered destination", async () => {
    await authorizePaymentDecision();
    const tamperedDestination = Keypair.random().publicKey();

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody({
          auditEntryId: lastAuditEntryId,
          destination: tamperedDestination,
        })
      )
    );

    expect(buildRes.status).toBe(403);
    const payload = (await buildRes.json()) as { error: string; field: string };
    expect(payload.field).toBe("destination");
    expect(payload.error).toContain("Destination");
  });

  it("rejects tampered amount", async () => {
    await authorizePaymentDecision();

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody({
          auditEntryId: lastAuditEntryId,
          amountXLM: "99.0000000",
        })
      )
    );

    expect(buildRes.status).toBe(403);
    const payload = (await buildRes.json()) as { error: string; field: string };
    expect(payload.field).toBe("amountXLM");
    expect(payload.error).toContain("Amount");
  });

  it("rejects tampered memo", async () => {
    await authorizePaymentDecision();

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody({
          auditEntryId: lastAuditEntryId,
          memo: "tampered-memo",
        })
      )
    );

    expect(buildRes.status).toBe(403);
    const payload = (await buildRes.json()) as { error: string; field: string };
    expect(payload.field).toBe("memo");
    expect(payload.error).toContain("Memo");
  });

  it("rejects tampered asset", async () => {
    await authorizePaymentDecision();

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody({
          auditEntryId: lastAuditEntryId,
          asset: "usdc",
        })
      )
    );

    expect(buildRes.status).toBe(400);
    const payload = (await buildRes.json()) as { error: string };
    expect(payload.error).toBe("Invalid payment build request.");
  });

  it("rejects tampered network in request schema", async () => {
    await authorizePaymentDecision();

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody({
          auditEntryId: lastAuditEntryId,
          network: "mainnet",
        })
      )
    );

    expect(buildRes.status).toBe(400);
    const payload = (await buildRes.json()) as { error: string };
    expect(payload.error).toBe("Invalid payment build request.");
  });

  it("builds a payment equal to the allowing cap", async () => {
    const { policy } = await getPolicyConfig();
    await updatePolicyConfig({ ...policy, perTxCapXLM: 18, dailyCapXLM: 300 }, "stroop-cap-equal");

    try {
      await seedAuthorizedPayment(18);
      horizonMocks.loadAccount.mockClear();
      horizonMocks.fetchBaseFee.mockClear();

      const buildRes = await buildPaymentPost(
        jsonRequest(
          "http://localhost/api/stellar/build-payment",
          authorizedBuildBody({ auditEntryId: lastAuditEntryId })
        )
      );

      expect(buildRes.status).toBe(200);
      const payload = (await buildRes.json()) as {
        ok: boolean;
        xdr: string;
        paymentQuote?: { amountStroops?: string };
      };
      expect(payload.ok).toBe(true);
      expect(payload.xdr.length).toBeGreaterThan(20);
      expect(payload.paymentQuote?.amountStroops).toBe("180000000");
    } finally {
      const current = await getPolicyConfig();
      await updatePolicyConfig(
        {
          ...current.policy,
          perTxCapXLM: policy.perTxCapXLM,
          dailyCapXLM: policy.dailyCapXLM,
        },
        "stroop-cap-restore"
      );
    }
  });

  it("denies a payment one stroop over the cap and does not build", async () => {
    const { policy } = await getPolicyConfig();
    await updatePolicyConfig(
      { ...policy, perTxCapXLM: 17.9999999, dailyCapXLM: 300 },
      "stroop-cap-lower"
    );

    try {
      await seedAuthorizedPayment(18);
      horizonMocks.loadAccount.mockClear();
      horizonMocks.fetchBaseFee.mockClear();

      const buildRes = await buildPaymentPost(
        jsonRequest(
          "http://localhost/api/stellar/build-payment",
          authorizedBuildBody({ auditEntryId: lastAuditEntryId })
        )
      );

      expect(buildRes.status).toBe(403);
      const payload = (await buildRes.json()) as { error: string };
      expect(payload.error).toContain("cap");
      expect(horizonMocks.loadAccount).not.toHaveBeenCalled();
      expect(horizonMocks.fetchBaseFee).not.toHaveBeenCalled();
    } finally {
      const current = await getPolicyConfig();
      await updatePolicyConfig(
        {
          ...current.policy,
          perTxCapXLM: policy.perTxCapXLM,
          dailyCapXLM: policy.dailyCapXLM,
        },
        "stroop-cap-restore"
      );
    }
  });

  it("rejects an extra fractional digit before building", async () => {
    horizonMocks.loadAccount.mockClear();

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        authorizedBuildBody({
          auditEntryId: "00000000-0000-4000-8000-000000000000",
          amountXLM: "18.00000001",
        })
      )
    );

    expect(buildRes.status).toBe(400);
    const payload = (await buildRes.json()) as {
      details?: { fieldErrors?: { amountXLM?: string[] } };
    };
    expect(payload.details?.fieldErrors?.amountXLM?.length).toBeGreaterThan(0);
    expect(horizonMocks.loadAccount).not.toHaveBeenCalled();
  });
});

function viewerCookie() {
  const token = createSessionToken({
    email: "viewer@fortexa.local",
    role: "viewer",
    userId: "build-payment-viewer",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

describe("POST /api/stellar/build-payment authorization", () => {
  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/stellar/build-payment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        auditEntryId: "any-id",
        destination: destinationKeypair.publicKey(),
        amountXLM: "10.0000000",
        asset: "native",
        memo: "fortexa:test",
        network: "testnet",
      }),
    });

    const response = await buildPaymentPost(request);
    expect(response.status).toBe(401);
  });

  it("returns 403 for viewer role (operator-only route)", async () => {
    const request = new NextRequest("http://localhost/api/stellar/build-payment", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie(),
      },
      body: JSON.stringify({
        auditEntryId: "any-id",
        destination: destinationKeypair.publicKey(),
        amountXLM: "10.0000000",
        asset: "native",
        memo: "fortexa:test",
        network: "testnet",
      }),
    });

    const response = await buildPaymentPost(request);
    expect(response.status).toBe(403);
  });
});
