import { promises as fs } from "node:fs";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmpDir = `/tmp/fortexa-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.FORTEXA_STORE_DIR = tmpDir;
  process.env.FORTEXA_AUTH_SECRET = "e2e-test-secret";
  process.env.STELLAR_HORIZON_URL = "https://horizon-mock.test";
  delete process.env.DATABASE_URL;
});

const horizonMocks = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  fetchBaseFee: vi.fn(),
  submitTransaction: vi.fn(),
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
    submitTransaction(tx: unknown) {
      return horizonMocks.submitTransaction(tx);
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

// Keep this fixture focused on the API handoff; the analyzer has separate tests.
vi.mock("@/lib/decision/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/decision/engine")>();
  return {
    ...actual,
    evaluateDecision: vi.fn(async (action: { amountXLM: number }) => ({
      decision: action.amountXLM === 95 ? "WARN" : "APPROVE",
      explanation: "Fixture decision",
      triggeredPolicies: [],
      riskScore: 0,
      riskFindings: [],
      requiresManualApproval: false,
      analyzerStatus: { isDegraded: false, blocklistStatus: "success", degradationReasons: [] },
      primaryRuleId: null,
    })),
  };
});

import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";

import { POST as decisionPost } from "@/app/api/decision/route";
import { POST as buildPaymentPost } from "@/app/api/stellar/build-payment/route";
import { POST as submitSignedPost } from "@/app/api/stellar/submit-signed/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import { listAuditEntries, resetAuditState } from "@/lib/storage/audit-store";
import { getPolicyConfig, updatePolicyConfig } from "@/lib/storage/policy-store";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";

const OPERATOR_USER_ID = "e2e-operator-id";

function operatorCookie() {
  const token = createSessionToken({
    email: "e2e-operator@fortexa.local",
    role: "operator",
    roles: ["operator", "signer"],
    userId: OPERATOR_USER_ID,
    publicKey: sourceKeypair.publicKey(),
    expiresInSeconds: 300,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function jsonRequest(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: operatorCookie(),
    },
    body: JSON.stringify(body),
  });
}

const sourceKeypair = Keypair.random();
const destinationKeypair = Keypair.random();
const mockTxHash = "a".repeat(64);

beforeAll(async () => {
  const { policy } = await getPolicyConfig();
  await updatePolicyConfig(
    {
      ...defaultPolicyConfig,
      ...policy,
      allowedHours: { start: 0, end: 23 },
    },
    "e2e-test-setup"
  );

  await upsertUserWallet(OPERATOR_USER_ID, {
    publicKey: sourceKeypair.publicKey(),
    source: "external",
    provider: "freighter",
  });
});

afterAll(async () => {
  const storeDir = process.env.FORTEXA_STORE_DIR;
  if (storeDir && storeDir.startsWith("/tmp/fortexa-e2e-")) {
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

beforeEach(async () => {
  horizonMocks.loadAccount.mockReset();
  horizonMocks.fetchBaseFee.mockReset();
  horizonMocks.submitTransaction.mockReset();

  horizonMocks.loadAccount.mockImplementation(async (accountId: string) => {
    return new Account(accountId, "1234");
  });
  horizonMocks.fetchBaseFee.mockResolvedValue(100);
  horizonMocks.submitTransaction.mockResolvedValue({
    hash: mockTxHash,
    ledger: 42,
    successful: true,
    result_xdr: "AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=",
  });

  await resetAuditState(OPERATOR_USER_ID);
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.FORTEXA_PAYMENT_QUOTE_TTL_SECONDS;
});

async function runOperatorFlow(
  decisionBody: Record<string, unknown>,
  paymentAmount: string,
  options: {
    beforeSubmit?: () => void | string | Promise<void | string>;
    decisionId?: string;
    expectedStatus?: number;
  } = {}
) {
  const decisionRes = await decisionPost(
    jsonRequest("http://localhost/api/decision", {
      ...decisionBody,
      paymentQuoteInput: {
        destination: destinationKeypair.publicKey(),
        memo: "e2e-test",
        network: "testnet",
      },
    })
  );
  expect(decisionRes.status).toBe(200);

  const decisionPayload = (await decisionRes.json()) as {
    result: { decision: string; riskScore: number };
    auditEntry: { id: string; decision: string; paymentQuote: { expiresAt: string } };
    userId: string;
  };

  const buildRes = await buildPaymentPost(
    jsonRequest("http://localhost/api/stellar/build-payment", {
      auditEntryId: decisionPayload.auditEntry.id,
      destination: destinationKeypair.publicKey(),
      amountXLM: paymentAmount,
      asset: "native",
      memo: "e2e-test",
      network: "testnet",
    })
  );
  expect(buildRes.status).toBe(200);

  const buildPayload = (await buildRes.json()) as {
    ok: boolean;
    xdr: string;
    networkPassphrase: string;
    sourcePublicKey: string;
    decisionId: string;
    quoteExpiresAt: string;
    buildAuthorization: string;
  };

  const unsignedTx = TransactionBuilder.fromXDR(buildPayload.xdr, buildPayload.networkPassphrase);
  unsignedTx.sign(sourceKeypair);
  const signedXdr = unsignedTx.toXDR();

  const replacementDecisionId = await options.beforeSubmit?.();
  const submitRes = await submitSignedPost(
    jsonRequest("http://localhost/api/stellar/submit-signed", {
      signedXdr,
      decisionId: options.decisionId ?? replacementDecisionId ?? buildPayload.decisionId,
      quoteExpiresAt: buildPayload.quoteExpiresAt,
      buildAuthorization: buildPayload.buildAuthorization,
    })
  );
  expect(submitRes.status).toBe(options.expectedStatus ?? 200);

  const submitPayload = (await submitRes.json()) as {
    ok: boolean;
    error?: string;
    explorerUrl: string;
    payment: { hash: string; ledger: number; status: string };
  };

  return { decisionPayload, buildPayload, submitPayload };
}

describe("E2E: decision → build XDR → submit (Horizon mocked)", () => {
  it("APPROVE path: safe scenario evaluates, builds XDR, and submits via mocked Horizon", async () => {
    const { decisionPayload, buildPayload, submitPayload } = await runOperatorFlow(
      { scenarioId: "safe-research-payment" },
      "18.0000000"
    );

    expect(decisionPayload.userId).toBe(OPERATOR_USER_ID);
    expect(decisionPayload.result.decision).toBe("APPROVE");

    const auditEntries = await listAuditEntries(OPERATOR_USER_ID);
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].decision).toBe("APPROVE");
    expect(auditEntries[0].id).toBe(decisionPayload.auditEntry.id);

    expect(buildPayload.ok).toBe(true);
    expect(buildPayload.decisionId).toBe(decisionPayload.auditEntry.id);
    expect(buildPayload.quoteExpiresAt).toBe(decisionPayload.auditEntry.paymentQuote.expiresAt);
    expect(buildPayload.networkPassphrase).toBe(Networks.TESTNET);
    expect(buildPayload.sourcePublicKey).toBe(sourceKeypair.publicKey());
    expect(typeof buildPayload.xdr).toBe("string");
    expect(buildPayload.xdr.length).toBeGreaterThan(20);
    expect(horizonMocks.loadAccount).toHaveBeenCalledWith(sourceKeypair.publicKey());
    expect(horizonMocks.fetchBaseFee).toHaveBeenCalled();

    expect(submitPayload.ok).toBe(true);
    expect(submitPayload.payment.hash).toBe(mockTxHash);
    expect(submitPayload.payment.status).toBe("submitted");
    expect(submitPayload.explorerUrl).toBe(
      `https://stellar.expert/explorer/testnet/tx/${mockTxHash}`
    );
    expect(horizonMocks.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("WARN path: medium-risk custom action still flows through build + submit", async () => {
    const warnAction = {
      id: "act-warn-e2e",
      name: "High-value approved research call",
      kind: "api_payment" as const,
      target: "research-pro:premium-report",
      domain: "api.safe-research.ai",
      amountXLM: 95,
      tool: "research-pro",
      outputPreview: "Routine premium report — no instructions to bypass anything.",
    };

    const { decisionPayload, submitPayload } = await runOperatorFlow(
      { action: warnAction },
      "95.0000000"
    );

    expect(decisionPayload.result.decision).toBe("WARN");

    const auditEntries = await listAuditEntries(OPERATOR_USER_ID);
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0].decision).toBe("WARN");

    expect(submitPayload.explorerUrl).toContain(mockTxHash);
    expect(submitPayload.payment.hash).toBe(mockTxHash);
  });

  it("never reaches live Horizon (mocked Server is the only Server used)", async () => {
    await runOperatorFlow({ scenarioId: "safe-research-payment" }, "18.0000000");

    expect(horizonMocks.loadAccount).toHaveBeenCalled();
    expect(horizonMocks.submitTransaction).toHaveBeenCalled();
  });

  it("rejects a quote that expires while the wallet is signing", async () => {
    process.env.FORTEXA_PAYMENT_QUOTE_TTL_SECONDS = "1";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    const { submitPayload } = await runOperatorFlow(
      { scenarioId: "safe-research-payment" },
      "18.0000000",
      {
        beforeSubmit: () => {
          vi.setSystemTime(new Date("2026-09-30T12:00:01.000Z"));
        },
        expectedStatus: 403,
      }
    );
    expect(submitPayload.error).toMatch(/quote|decision/i);
    expect(horizonMocks.submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects a swapped decision id for the signed build", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
    const { submitPayload } = await runOperatorFlow(
      { scenarioId: "safe-research-payment" },
      "18.0000000",
      {
        beforeSubmit: async () => {
          const secondDecision = await decisionPost(
            jsonRequest("http://localhost/api/decision", {
              scenarioId: "safe-research-payment",
              paymentQuoteInput: {
                destination: destinationKeypair.publicKey(),
                memo: "e2e-test",
                network: "testnet",
              },
            })
          );
          expect(secondDecision.status).toBe(200);
          const payload = (await secondDecision.json()) as { auditEntry: { id: string } };
          return payload.auditEntry.id;
        },
        expectedStatus: 403,
      }
    );
    expect(submitPayload.error).toMatch(/authorized payment build/i);
    expect(horizonMocks.submitTransaction).not.toHaveBeenCalled();
  });
});
