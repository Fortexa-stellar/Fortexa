declare global {
  var MOCK_SESSION_PUBLIC_KEY: string | undefined;
}

import { Account, Asset, Keypair, Memo, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const { getAuditEntryMock, verifyQuoteMock } = vi.hoisted(() => ({
  verifyQuoteMock: vi.fn(),
}));

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/http/read-json-body", () => ({
  readJsonBody: vi.fn(),
}));

vi.mock("@/lib/observability/http", () => ({
  jsonWithRequestContext: vi.fn(
    (
      _request: unknown,
      opts: { status: number; body: unknown; headers?: Record<string, string> },
    ) =>
      new Response(JSON.stringify(opts.body), {
        status: opts.status,
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers ?? {}),
        },
      }),
  ),
}));

vi.mock("@/lib/observability/logger", () => ({
  getRequestLogContext: vi.fn(() => ({})),
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/observability/metrics", () => ({
  recordStellarSubmitResult: vi.fn(),
}));

vi.mock("@/lib/security/rate-limit", () => ({
  consumeRateLimit: vi.fn(async () => ({ ok: true })),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/storage/submit-idempotency-store", () => ({
  getIdempotencyRecord: vi.fn(),
  hashSignedXdr: vi.fn(() => "hash"),
  maybeRunCleanup: vi.fn(),
  putIdempotencyRecord: vi.fn(),
}));

vi.mock("@/lib/storage/user-wallet-store", () => ({
  getUserWallet: vi.fn(),
}));

vi.mock("@/lib/storage/audit-store", () => ({ getAuditEntryById: vi.fn(async () => ({ id: "decision-1" })) }));
vi.mock("@/lib/stellar/verify-payment-quote", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stellar/verify-payment-quote")>(),
  isPaymentDecisionCurrent: vi.fn(() => true),
}));
vi.mock("@/lib/stellar/payment-build-authorization", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stellar/payment-build-authorization")>(),
  verifyBuildAuthorization: vi.fn(() => true),
}));

vi.mock("@/lib/validation/schemas", () => ({
  stellarSubmitSignedRequestSchema: {
    safeParse: vi.fn(),
  },
}));

vi.mock("@/lib/utils/horizonErrors", () => ({
  normalizeHorizonError: vi.fn(() => "unknown"),
}));

vi.mock("@/lib/stellar/network-config", () => ({
  assertStellarNetworkConfig: () => ({
    networkPassphrase: Networks.TESTNET,
    horizonUrl: "https://horizon-testnet.stellar.org",
  }),
  getStellarHorizonUrl: () => "https://horizon-testnet.stellar.org",
}));

vi.mock("@/lib/stellar/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/client")>();
  return {
    ...actual,
    submitSignedTransactionXdr: vi.fn(async () => ({
      hash: "deadbeef",
      status: "submitted",
      ledger: 1,
      resultXdr: "",
    })),
  };
});

import { requireAuth } from "@/lib/auth/require-auth";
import { readJsonBody } from "@/lib/http/read-json-body";
import { buildDecisionReceipt } from "@/lib/stellar/verify-payment-quote";
import { getUserWallet } from "@/lib/storage/user-wallet-store";
import { stellarSubmitSignedRequestSchema } from "@/lib/validation/schemas";

function buildSignedXdr(
  signerKp: Keypair,
  sourcePublicKey: string,
  destinationPublicKey = Keypair.random().publicKey(),
  amount = "1",
  memo = "approved-memo",
) {
  const account = new Account(sourcePublicKey, "1");
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount,
      }),
    )
    .addMemo(memo ? Memo.text(memo) : undefined)
    .setTimeout(180)
    .build();
  tx.sign(signerKp);
  return tx.toXDR();
}

function buildRequest(body: unknown) {
  return new NextRequest("http://localhost/api/stellar/submit-signed", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makeDecisionReceipt(
  destination: string,
  amount = "1",
  memo = "approved-memo",
) {
  return buildDecisionReceipt({
    destination,
    amountXLM: amount,
    asset: "native",
    memo,
    network: "testnet",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockImplementation(() => ({
    ok: true,
    session: { userId: "user-1", publicKey: globalThis.MOCK_SESSION_PUBLIC_KEY || "GCDEFAULTTESTWALLET123" },
  } as ReturnType<typeof requireAuth>));
});

describe("POST /api/stellar/submit-signed - source wallet verification", () => {
  it("accepts a submission whose XDR source matches the session wallet and the decision receipt", async () => {
    const walletKp = Keypair.random();
    globalThis.MOCK_SESSION_PUBLIC_KEY = walletKp.publicKey();
    const destination = Keypair.random().publicKey();
    const signedXdr = buildSignedXdr(walletKp, walletKp.publicKey(), destination, "1", "test-memo");
    const decisionReceipt = makeDecisionReceipt(destination, "1", "test-memo");

    vi.mocked(getUserWallet).mockResolvedValue({
      userId: "user-1",
      publicKey: walletKp.publicKey(),
      source: "external",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(readJsonBody).mockResolvedValue({
      ok: true,
      data: { signedXdr, decisionReceipt },
    });
    vi.mocked(stellarSubmitSignedRequestSchema.safeParse).mockReturnValue({
      success: true,
      data: { signedXdr, decisionReceipt },
    } as ReturnType<typeof stellarSubmitSignedRequestSchema.safeParse>);

    const response = await POST(buildRequest({ signedXdr, decisionReceipt }));
    const body = await response.json();

    expect(requireAuth).toHaveBeenCalledWith(expect.any(NextRequest), { allowedRoles: ["signer"] });
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("rejects a submission whose signed XDR disagrees with the bound decision receipt", async () => {
    const walletKp = Keypair.random();
    const authorizedDestination = Keypair.random().publicKey();
    const swappedDestination = Keypair.random().publicKey();
    const signedXdr = buildSignedXdr(
      walletKp,
      walletKp.publicKey(),
      swappedDestination,
      "1",
      "approved-memo",
    );
    const decisionReceipt = makeDecisionReceipt(
      authorizedDestination,
      "1",
      "approved-memo",
    );

    vi.mocked(getUserWallet).mockResolvedValue({
      userId: "user-1",
      publicKey: walletKp.publicKey(),
      source: "external",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(readJsonBody).mockResolvedValue({
      ok: true,
      data: { signedXdr, decisionReceipt },
    });
    vi.mocked(stellarSubmitSignedRequestSchema.safeParse).mockReturnValue({
      success: true,
      data: { signedXdr, decisionReceipt },
    } as ReturnType<typeof stellarSubmitSignedRequestSchema.safeParse>);

    const response = await POST(buildRequest({ signedXdr, decisionReceipt }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(
      /does not match the authorized payment decision/i,
    );
  });

  it("rejects a submission whose XDR source does not match the session wallet", async () => {
    const sessionWalletKp = Keypair.random();
    const otherKp = Keypair.random();
    const destination = Keypair.random().publicKey();
    const signedXdr = buildSignedXdr(
      otherKp,
      otherKp.publicKey(),
      destination,
      "1",
      "approved-memo",
    );

    vi.mocked(getUserWallet).mockResolvedValue({
      userId: "user-1",
      publicKey: sessionWalletKp.publicKey(),
      source: "external",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const decisionReceipt = makeDecisionReceipt(
      destination,
      "1",
      "approved-memo",
    );
    vi.mocked(readJsonBody).mockResolvedValue({
      ok: true,
      data: { signedXdr, decisionReceipt },
    });
    vi.mocked(stellarSubmitSignedRequestSchema.safeParse).mockReturnValue({
      success: true,
      data: { signedXdr, decisionReceipt },
    } as ReturnType<typeof stellarSubmitSignedRequestSchema.safeParse>);

    const response = await POST(buildRequest({ signedXdr, decisionReceipt }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/does not match/i);
  });

  it("rejects a signed payment when its decision does not allow execution", async () => {
    const walletKp = Keypair.random();
    const signedXdr = buildSignedXdr(walletKp, walletKp.publicKey());
    vi.mocked(getUserWallet).mockResolvedValue({
      userId: "user-1",
      publicKey: walletKp.publicKey(),
      source: "external",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    vi.mocked(readJsonBody).mockResolvedValue({
      ok: true,
      data: { signedXdr, auditEntryId: "00000000-0000-4000-8000-000000000000" },
    });
    vi.mocked(stellarSubmitSignedRequestSchema.safeParse).mockReturnValue({
      success: true,
      data: { signedXdr, auditEntryId: "00000000-0000-4000-8000-000000000000" },
    } as ReturnType<typeof stellarSubmitSignedRequestSchema.safeParse>);
    verifyQuoteMock.mockReturnValueOnce({
      ok: false,
      status: 403,
      error: "Decision does not authorize payment execution.",
    });

    const response = await POST(buildRequest({ signedXdr }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "Decision does not authorize payment execution.",
    });
  });

  it("rejects malformed XDR with a 400", async () => {
    const walletKp = Keypair.random();
    globalThis.MOCK_SESSION_PUBLIC_KEY = walletKp.publicKey();

    vi.mocked(getUserWallet).mockResolvedValue({
      userId: "user-1",
      publicKey: walletKp.publicKey(),
      source: "external",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const decisionReceipt = makeDecisionReceipt(
      walletKp.publicKey(),
      "1",
      "approved-memo",
    );
    vi.mocked(readJsonBody).mockResolvedValue({
      ok: true,
      data: { signedXdr: "not-valid-xdr", decisionReceipt },
    });
    vi.mocked(stellarSubmitSignedRequestSchema.safeParse).mockReturnValue({
      success: true,
      data: { signedXdr: "not-valid-xdr", decisionReceipt },
    } as ReturnType<typeof stellarSubmitSignedRequestSchema.safeParse>);

    const response = await POST(
      buildRequest({ signedXdr: "not-valid-xdr", decisionReceipt }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/could not be decoded/i);
  });

  it("rejects with 401 when there is no session wallet mapping", async () => {
    vi.mocked(getUserWallet).mockResolvedValue(null);

    const decisionReceipt = buildDecisionReceipt({
      destination: Keypair.random().publicKey(),
      amountXLM: "1",
      asset: "native",
      memo: "approved-memo",
      network: "testnet",
    });

    const response = await POST(
      buildRequest({ signedXdr: "anything", decisionReceipt }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toMatch(/no session wallet mapping/i);
  });
});

describe("POST /api/stellar/submit-signed authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(requireAuth).mockReturnValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Authentication required." }),
        {
          status: 401,
        },
      ),
    } as ReturnType<typeof requireAuth>);

    const request = new NextRequest(
      "http://localhost/api/stellar/submit-signed",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedXdr: "AAAA" }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("returns 403 for viewer role (operator-only route)", async () => {
    vi.mocked(requireAuth).mockReturnValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "Insufficient role." }), {
        status: 403,
      }),
    } as ReturnType<typeof requireAuth>);

    const request = new NextRequest(
      "http://localhost/api/stellar/submit-signed",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedXdr: "AAAA" }),
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(403);
  });
});
