import { promises as fs } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmpDir = `/tmp/fortexa-error-codes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.FORTEXA_STORE_DIR = tmpDir;
  process.env.FORTEXA_AUTH_SECRET = "stable-error-codes-secret-key-12345";
  process.env.STELLAR_HORIZON_URL = "https://horizon-testnet.stellar.org";
  process.env.STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
  delete process.env.DATABASE_URL;
});

import { POST as postPolicy } from "@/app/api/policy/route";
import { POST as postDecision } from "@/app/api/decision/route";
import { POST as postBuildPayment } from "@/app/api/stellar/build-payment/route";
import { POST as postSubmitSigned } from "@/app/api/stellar/submit-signed/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { getFortexaStoreDir } from "@/lib/storage/paths";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";
import {
  INVALID_AMOUNT,
  INVALID_ASSET,
  INVALID_MEMO,
  MISSING_FIELD,
  VALIDATION_ERROR_CODES,
} from "./errors";

const TEST_USER_ID = "stable-codes-test-user";
const operatorWalletKp = Keypair.random();
const destinationKp = Keypair.random();

function operatorCookie() {
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    roles: ["operator", "signer"],
    userId: TEST_USER_ID,
    publicKey: operatorWalletKp.publicKey(),
    expiresInSeconds: 300,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function makeRequest(url: string, body: unknown, cookie = operatorCookie()) {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });
}

const VALID_POLICY_BASE = {
  allowedDomains: ["api.example.com"],
  blockedDomains: ["malicious.com"],
  allowedTools: ["research-pro"],
  blockedTools: ["shadow-shell"],
  perTxCapXLM: 150,
  dailyCapXLM: 300,
  maxToolCallsPerDay: 10,
  riskThreshold: 80,
  allowedHours: { start: 6, end: 23 },
};

describe("Issue #257: Stable Validation Error Codes across policy and payment routes", () => {
  beforeAll(async () => {
    await fs.mkdir(getFortexaStoreDir(), { recursive: true });
    await upsertUserWallet(TEST_USER_ID, {
      publicKey: operatorWalletKp.publicKey(),
      source: "external",
      provider: "freighter",
    });
  });

  afterAll(async () => {
    await fs.rm(getFortexaStoreDir(), { recursive: true, force: true });
  });

  it("exports all required stable validation error codes", () => {
    expect(VALIDATION_ERROR_CODES.MISSING_FIELD).toBe("MISSING_FIELD");
    expect(VALIDATION_ERROR_CODES.INVALID_AMOUNT).toBe("INVALID_AMOUNT");
    expect(VALIDATION_ERROR_CODES.INVALID_ASSET).toBe("INVALID_ASSET");
    expect(VALIDATION_ERROR_CODES.INVALID_MEMO).toBe("INVALID_MEMO");
    expect(VALIDATION_ERROR_CODES.INVALID_PAYLOAD).toBe("INVALID_PAYLOAD");
  });

  it("returns INVALID_AMOUNT with status 400 on both policy write and payment build", async () => {
    // 1. Policy route with bad amount (more decimal places than asset allows)
    const policyReq = makeRequest("http://localhost/api/policy", {
      ...VALID_POLICY_BASE,
      perTxCapXLM: 1.12345678,
    });
    const policyRes = await postPolicy(policyReq);
    expect(policyRes.status).toBe(400);
    const policyData = (await policyRes.json()) as { code: string; error: string; details: unknown };
    expect(policyData.code).toBe(INVALID_AMOUNT);

    // 2. Build payment route with bad amount (more decimal places or invalid amount)
    const buildReq = makeRequest("http://localhost/api/stellar/build-payment", {
      auditEntryId: "00000000-0000-4000-8000-000000000000",
      destination: destinationKp.publicKey(),
      amountXLM: "18.00000001",
      asset: "native",
      network: "testnet",
    });
    const buildRes = await postBuildPayment(buildReq);
    expect(buildRes.status).toBe(400);
    const buildData = (await buildRes.json()) as { code: string; error: string; details: unknown };
    expect(buildData.code).toBe(INVALID_AMOUNT);

    // Parity assertion: Both policy write and build payment return the exact same code
    expect(policyData.code).toBe(buildData.code);
    expect(policyRes.status).toBe(buildRes.status);
  });

  it("returns INVALID_MEMO with status 400 on both decision and submit-signed", async () => {
    const tooLongMemo = "this-memo-exceeds-the-stellar-twenty-eight-character-limit";

    // 1. Decision route with invalid memo in paymentQuoteInput
    const decisionReq = makeRequest("http://localhost/api/decision", {
      scenarioId: "safe-research-payment",
      paymentQuoteInput: {
        destination: destinationKp.publicKey(),
        memo: tooLongMemo,
        network: "testnet",
      },
    });
    const decisionRes = await postDecision(decisionReq);
    expect(decisionRes.status).toBe(400);
    const decisionData = (await decisionRes.json()) as { code: string; error: string };
    expect(decisionData.code).toBe(INVALID_MEMO);

    // 2. Submit signed route with invalid memo in decisionReceipt
    const submitReq = makeRequest("http://localhost/api/stellar/submit-signed", {
      signedXdr: "AAAAAG...",
      decisionReceipt: {
        destination: destinationKp.publicKey(),
        amountXLM: "10.0000000",
        asset: "native",
        memo: tooLongMemo,
        network: "testnet",
      },
    });
    const submitRes = await postSubmitSigned(submitReq);
    expect(submitRes.status).toBe(400);
    const submitData = (await submitRes.json()) as { code: string; error: string };
    expect(submitData.code).toBe(INVALID_MEMO);

    // Parity assertion: Both decision and submit signed return the exact same code
    expect(decisionData.code).toBe(submitData.code);
    expect(decisionRes.status).toBe(submitRes.status);
  });

  it("returns INVALID_ASSET with status 400 across decision, build, and submit routes", async () => {
    // 1. Build payment with invalid asset
    const buildReq = makeRequest("http://localhost/api/stellar/build-payment", {
      auditEntryId: "00000000-0000-4000-8000-000000000000",
      destination: destinationKp.publicKey(),
      amountXLM: "10.0000000",
      asset: "unknown_token",
      network: "testnet",
    });
    const buildRes = await postBuildPayment(buildReq);
    expect(buildRes.status).toBe(400);
    const buildData = (await buildRes.json()) as { code: string };
    expect(buildData.code).toBe(INVALID_ASSET);

    // 2. Submit signed with invalid asset
    const submitReq = makeRequest("http://localhost/api/stellar/submit-signed", {
      signedXdr: "AAAAAG...",
      decisionReceipt: {
        destination: destinationKp.publicKey(),
        amountXLM: "10.0000000",
        asset: "unknown_token",
        memo: "approved-memo",
        network: "testnet",
      },
    });
    const submitRes = await postSubmitSigned(submitReq);
    expect(submitRes.status).toBe(400);
    const submitData = (await submitRes.json()) as { code: string };
    expect(submitData.code).toBe(INVALID_ASSET);

    expect(buildData.code).toBe(submitData.code);
  });

  it("returns MISSING_FIELD with status 400 when required fields are missing", async () => {
    // 1. Policy route missing fields
    const policyRes = await postPolicy(makeRequest("http://localhost/api/policy", {}));
    expect(policyRes.status).toBe(400);
    const policyData = (await policyRes.json()) as { code: string };
    expect(policyData.code).toBe(MISSING_FIELD);

    // 2. Build payment missing destination and amount
    const buildRes = await postBuildPayment(
      makeRequest("http://localhost/api/stellar/build-payment", {
        auditEntryId: "00000000-0000-4000-8000-000000000000",
      }),
    );
    expect(buildRes.status).toBe(400);
    const buildData = (await buildRes.json()) as { code: string };
    expect(buildData.code).toBe(MISSING_FIELD);

    // 3. Submit signed missing signedXdr
    const submitRes = await postSubmitSigned(
      makeRequest("http://localhost/api/stellar/submit-signed", {}),
    );
    expect(submitRes.status).toBe(400);
    const submitData = (await submitRes.json()) as { code: string };
    expect(submitData.code).toBe(MISSING_FIELD);
  });

  it("does not leak raw request bodies or unredacted secrets in validation error responses", async () => {
    const rawSecret = "super-secret-token-xyz-123456";
    const sensitivePayload = {
      ...VALID_POLICY_BASE,
      perTxCapXLM: "invalid_amount_value",
      secret: rawSecret,
      apiKey: "unredacted_key_999",
      sessionToken: "session_token_should_not_leak",
    };

    const policyRes = await postPolicy(makeRequest("http://localhost/api/policy", sensitivePayload));
    expect(policyRes.status).toBe(400);
    const responseText = await policyRes.text();

    expect(responseText).not.toContain(rawSecret);
    expect(responseText).not.toContain("unredacted_key_999");
    expect(responseText).not.toContain("session_token_should_not_leak");
  });
});
