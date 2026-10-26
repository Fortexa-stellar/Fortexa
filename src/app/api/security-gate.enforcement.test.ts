/**
 * Shared enforcement gate route coverage (issue #202).
 *
 * Matrix:
 *
 * | Route                       | Blocklisted destination | Over-limit caller | Allowed traffic |
 * |-----------------------------|-------------------------|-------------------|-----------------|
 * | POST /api/decision          | 403 BLOCKLISTED         | 429 RATE_LIMITED  | 200             |
 * | POST .../build-payment      | 403 BLOCKLISTED         | 429 RATE_LIMITED  | 200             |
 * | POST .../submit-signed      | 403 BLOCKLISTED         | 429 RATE_LIMITED  | 200             |
 *
 * The gate runs before policy evaluation, XDR construction, and Horizon
 * submission, so a destination blocked on one route is blocked on all three.
 */

import { promises as fs } from "node:fs";

import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmpDir = `/tmp/fortexa-gate-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.FORTEXA_STORE_DIR = tmpDir;
  process.env.FORTEXA_AUTH_SECRET = "gate-route-test-secret";
  process.env.STELLAR_HORIZON_URL = "https://horizon-mock.test";
  // hoisted block runs before imports: build the path without node:path
  process.env.FORTEXA_SHARED_STATE_PATH = `${tmpDir}/shared-security-state.json`;
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
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
    submitTransaction(transaction: unknown) {
      return horizonMocks.submitTransaction(transaction);
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

import { NextRequest } from "next/server";

import { POST as decisionPost } from "@/app/api/decision/route";
import { POST as buildPaymentPost } from "@/app/api/stellar/build-payment/route";
import { POST as submitSignedPost } from "@/app/api/stellar/submit-signed/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { buildDecisionReceipt } from "@/lib/stellar/verify-payment-quote";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import { resetBlocklistCache } from "@/lib/security/blocklist";
import { resetRateLimitStore } from "@/lib/security/rate-limit";
import { resetAuditState } from "@/lib/storage/audit-store";
import { updatePolicyConfig } from "@/lib/storage/policy-store";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";
import type { AgentAction } from "@/lib/types/domain";

const OPERATOR_USER_ID = "gate-route-operator";
const BLOCKED_DOMAIN = "gate-blocked.example";
const CLEAN_DOMAIN = "clean.example";

const sourceKeypair = Keypair.random();
const destinationKeypair = Keypair.random();

function operatorCookie() {
  const token = createSessionToken({
    email: "gate-route@fortexa.local",
    role: "operator",
    roles: ["operator", "signer"],
    userId: OPERATOR_USER_ID,
    expiresInSeconds: 600,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function jsonRequest(url: string, body: unknown, ip = "10.77.0.1") {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: operatorCookie(),
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

function decisionBody(domain: string) {
  const action: AgentAction = {
    id: "act-gate-1",
    name: "Gate test payment",
    kind: "api_payment",
    target: "https://api.example.com/charge",
    domain,
    amountXLM: 5,
  };
  return {
    action,
    paymentQuoteInput: {
      destination: destinationKeypair.publicKey(),
      memo: "gate route test",
      network: "testnet",
    },
  };
}

async function seedPolicy() {
  await updatePolicyConfig(
    {
      ...defaultPolicyConfig,
      allowedDomains: [CLEAN_DOMAIN],
      blockedDomains: [],
      allowedTools: ["payment-api"],
      blockedTools: ["shell"],
      allowedHours: { start: 0, end: 23 },
    },
    "gate-route-test-setup"
  );
}

beforeAll(async () => {
  await seedPolicy();
  await upsertUserWallet(OPERATOR_USER_ID, {
    publicKey: sourceKeypair.publicKey(),
    source: "external",
    provider: "freighter",
  });
});

beforeEach(async () => {
  horizonMocks.loadAccount.mockReset();
  horizonMocks.fetchBaseFee.mockReset();
  horizonMocks.submitTransaction.mockReset();
  horizonMocks.loadAccount.mockImplementation(async (accountId: string) => {
    return new Account(accountId, "1234");
  });
  horizonMocks.fetchBaseFee.mockResolvedValue(100);
  await resetAuditState(OPERATOR_USER_ID);
});

afterEach(async () => {
  delete process.env.FORTEXA_BLOCKLIST_URL;
  resetBlocklistCache();
  vi.restoreAllMocks();
  await resetRateLimitStore();
});

afterAll(async () => {
  const storeDir = process.env.FORTEXA_STORE_DIR;
  if (storeDir?.startsWith("/tmp/fortexa-gate-routes-")) {
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});

describe("shared enforcement gate across routes", () => {
  function setBlocklistFeed(domains: string[]) {
    // The feed caches for 5 minutes; clear so a re-mocked feed takes effect
    // when several tests (or feed swaps within one test) run in sequence.
    resetBlocklistCache();
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(domains), { status: 200 })
    );
  }

  it("denies a blocklisted destination on decision with 403 BLOCKLISTED", async () => {
    // The decision quote destination is a Stellar account id, so the feed
    // carries the lowercased account id; the gate extracts it from the
    // paymentQuoteInput.destination the same way build/submit do.
    setBlocklistFeed([destinationKeypair.publicKey().toLowerCase()]);

    const response = await decisionPost(
      jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN))
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code?: string; error?: string };
    expect(payload.code).toBe("BLOCKLISTED");
  });

  it("denies a blocklisted action domain on decision with 403 BLOCKLISTED", async () => {
    setBlocklistFeed([BLOCKED_DOMAIN]);

    const body = decisionBody(BLOCKED_DOMAIN);
    // No quote destination needed to exercise the domain check: the gate
    // also checks the action domain via the same feed.
    delete (body as { paymentQuoteInput?: unknown }).paymentQuoteInput;

    const response = await decisionPost(jsonRequest("http://localhost/api/decision", body));

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe("BLOCKLISTED");
  });

  it("denies a blocklisted destination on build-payment with 403 BLOCKLISTED", async () => {
    setBlocklistFeed([BLOCKED_DOMAIN]);

    // Authorize a quote against the clean destination first (blocklist
    // applied to the *build* destination below).
    const decisionRes = await decisionPost(
      jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN), "10.77.1.1")
    );
    expect(decisionRes.status).toBe(200);
    const decisionPayload = (await decisionRes.json()) as {
      auditEntry: { id: string };
    };

    setBlocklistFeed([destinationKeypair.publicKey().toLowerCase()]);

    const response = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        {
          auditEntryId: decisionPayload.auditEntry.id,
          destination: destinationKeypair.publicKey(),
          amountXLM: "5.0000000",
          asset: "native",
          memo: "gate route test",
          network: "testnet",
        },
        "10.77.1.2"
      )
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe("BLOCKLISTED");
  });

  it("denies a blocklisted destination on submit-signed with 403 BLOCKLISTED", async () => {
    // Build a genuinely signed XDR whose payment op targets a destination
    // account id present in the feed (host extraction yields the raw
    // lowercased G-address for account-id destinations).
    const account = new Account(sourceKeypair.publicKey(), "1");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destinationKeypair.publicKey(),
          asset: Asset.native(),
          amount: "5.0000000",
        })
      )
      .setTimeout(30)
      .build();
    tx.sign(sourceKeypair);

    setBlocklistFeed([destinationKeypair.publicKey().toLowerCase()]);

    const response = await submitSignedPost(
      jsonRequest(
        "http://localhost/api/stellar/submit-signed",
        { signedXdr: tx.toXDR() },
        "10.77.2.1"
      )
    );

    expect(response.status).toBe(403);
    const payload = (await response.json()) as { code?: string };
    expect(payload.code).toBe("BLOCKLISTED");
    expect(horizonMocks.submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects the request after the limit with 429 RATE_LIMITED on decision", async () => {
    const ip = "10.77.3.1";
    // Decision limiter allows 40/min for this route; exhaust it.
    for (let i = 0; i < 40; i += 1) {
      const res = await decisionPost(
        jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN), ip)
      );
      expect(res.status).toBe(200);
    }

    const denied = await decisionPost(
      jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN), ip)
    );

    expect(denied.status).toBe(429);
    const payload = (await denied.json()) as { code?: string };
    expect(payload.code).toBe("RATE_LIMITED");
  });

  it("rejects the request after the limit with 429 RATE_LIMITED on build-payment", async () => {
    const decisionRes = await decisionPost(
      jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN), "10.77.4.1")
    );
    expect(decisionRes.status).toBe(200);
    const { auditEntry } = (await decisionRes.json()) as {
      auditEntry: { id: string };
    };

    const buildBody = {
      auditEntryId: auditEntry.id,
      destination: destinationKeypair.publicKey(),
      amountXLM: "5.0000000",
      asset: "native",
      memo: "gate route test",
      network: "testnet",
    };

    const ip = "10.77.4.2";
    for (let i = 0; i < 30; i += 1) {
      const res = await buildPaymentPost(
        jsonRequest("http://localhost/api/stellar/build-payment", buildBody, ip)
      );
      expect(res.status).toBe(200);
    }

    const denied = await buildPaymentPost(
      jsonRequest("http://localhost/api/stellar/build-payment", buildBody, ip)
    );

    expect(denied.status).toBe(429);
    const payload = (await denied.json()) as { code?: string };
    expect(payload.code).toBe("RATE_LIMITED");
  });

  it("rejects the request after the limit with 429 RATE_LIMITED on submit-signed", async () => {
    horizonMocks.submitTransaction.mockResolvedValue({
      hash: "gate-test-hash",
      successful: true,
      ledger: 1,
      result_xdr: "",
    });

    let sequence = 1;
    const makeSignedXdr = () => {
      const account = new Account(sourceKeypair.publicKey(), String(sequence++));
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(
          Operation.payment({
            destination: destinationKeypair.publicKey(),
            asset: Asset.native(),
            amount: "1.0000000",
          })
        )
        .addMemo(Memo.text("gate route test"))
        .setTimeout(30)
        .build();
      tx.sign(sourceKeypair);
      return tx.toXDR();
    };

    const ip = "10.77.5.1";
    for (let i = 0; i < 30; i += 1) {
      const signedXdr = makeSignedXdr();
      const decisionReceipt = buildDecisionReceipt({
        destination: destinationKeypair.publicKey(),
        amountXLM: "1.0000000",
        asset: "native",
        memo: "gate route test",
        network: "testnet",
      });
      const res = await submitSignedPost(
        jsonRequest(
          "http://localhost/api/stellar/submit-signed",
          { signedXdr, decisionReceipt },
          ip
        )
      );
      expect(res.status).toBe(200);
    }

    const deniedSignedXdr = makeSignedXdr();
    const deniedDecisionReceipt = buildDecisionReceipt({
      destination: destinationKeypair.publicKey(),
      amountXLM: "1.0000000",
      asset: "native",
      memo: "gate route test",
      network: "testnet",
    });
    const denied = await submitSignedPost(
      jsonRequest(
        "http://localhost/api/stellar/submit-signed",
        { signedXdr: deniedSignedXdr, decisionReceipt: deniedDecisionReceipt },
        ip
      )
    );

    expect(denied.status).toBe(429);
    const payload = (await denied.json()) as { code?: string };
    expect(payload.code).toBe("RATE_LIMITED");
  });

  it("keeps allowed traffic on the normal success response", async () => {
    const decisionRes = await decisionPost(
      jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN), "10.77.6.1")
    );
    expect(decisionRes.status).toBe(200);
    const decisionPayload = (await decisionRes.json()) as {
      result: { decision: string };
      auditEntry: { id: string };
    };
    // UNLISTED_DOMAIN is a soft (medium) trigger; a clean payment still
    // executes with a warning, which is enough to assert allowed traffic.
    expect(["APPROVE", "WARN"]).toContain(decisionPayload.result.decision);
    expect(decisionPayload.auditEntry.id).toBeTruthy();

    horizonMocks.submitTransaction.mockResolvedValue({
      hash: "gate-success-hash",
      successful: true,
      ledger: 42,
      result_xdr: "",
    });

    const buildRes = await buildPaymentPost(
      jsonRequest(
        "http://localhost/api/stellar/build-payment",
        {
          auditEntryId: decisionPayload.auditEntry.id,
          destination: destinationKeypair.publicKey(),
          amountXLM: "5.0000000",
          asset: "native",
          memo: "gate route test",
          network: "testnet",
        },
        "10.77.6.2"
      )
    );
    expect(buildRes.status).toBe(200);
    const buildPayload = (await buildRes.json()) as { ok?: boolean; xdr?: string };
    expect(buildPayload.ok).toBe(true);
    expect(typeof buildPayload.xdr).toBe("string");

    const account = new Account(sourceKeypair.publicKey(), "100");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destinationKeypair.publicKey(),
          asset: Asset.native(),
          amount: "5.0000000",
        })
      )
      .addMemo(Memo.text("gate route test"))
      .setTimeout(30)
      .build();
    tx.sign(sourceKeypair);

    const decisionReceipt = buildDecisionReceipt({
      destination: destinationKeypair.publicKey(),
      amountXLM: "5.0000000",
      asset: "native",
      memo: "gate route test",
      network: "testnet",
    });

    const submitRes = await submitSignedPost(
      jsonRequest(
        "http://localhost/api/stellar/submit-signed",
        { signedXdr: tx.toXDR(), decisionReceipt },
        "10.77.6.3"
      )
    );
    expect(submitRes.status).toBe(200);
    const submitPayload = (await submitRes.json()) as {
      ok?: boolean;
      explorerUrl?: string;
    };
    expect(submitPayload.ok).toBe(true);
    expect(submitPayload.explorerUrl).toContain("stellar.expert");
  });

  it("keeps a blocklisted destination out of metrics labels", async () => {
    setBlocklistFeed([BLOCKED_DOMAIN]);

    const response = await decisionPost(
      jsonRequest("http://localhost/api/decision", decisionBody(BLOCKED_DOMAIN), "10.77.7.1")
    );
    expect(response.status).toBe(403);

    const { getMetricsSnapshot } = await import("@/lib/observability/metrics");
    const serialized = JSON.stringify(getMetricsSnapshot());
    expect(serialized).not.toContain(BLOCKED_DOMAIN);
    expect(serialized).not.toContain(destinationKeypair.publicKey());
  });

  it("keeps the limit exact when parallel requests hit decision concurrently", async () => {
    // Use a tiny limiter window through the gate itself: decision allows 40.
    // Concurrency is proven at the unit level for arbitrary limits; here we
    // verify no more than the configured budget is granted under parallelism.
    const ip = "10.77.8.";
    const batch = Array.from({ length: 20 }, (_, i) =>
      decisionPost(
        jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN), `${ip}${i}`)
      )
    );
    const responses = await Promise.all(batch);
    // Distinct IPs each get their own budget: all should succeed.
    for (const response of responses) {
      expect(response.status).toBe(200);
    }

    // Same IP, 40 parallel requests against the 40-request budget.
    const sameIp = "10.77.9.5";
    const parallel = Array.from({ length: 45 }, () =>
      decisionPost(jsonRequest("http://localhost/api/decision", decisionBody(CLEAN_DOMAIN), sameIp))
    );
    const settled = await Promise.all(parallel);
    const statuses = settled.map((r) => r.status);
    const allowedCount = statuses.filter((s) => s === 200).length;
    const limitedCount = statuses.filter((s) => s === 429).length;

    // Not all 40 in-budget requests necessarily reach 200 (usage/policy may
    // warn), but exactly 40 must be past the gate and 5 rate-limited.
    expect(allowedCount).toBe(40);
    expect(limitedCount).toBe(5);
  });
});
