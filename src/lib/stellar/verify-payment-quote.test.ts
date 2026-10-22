import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPaymentQuoteFromDecision,
  isPaymentDecisionCurrent,
  normalizeAmountXLM,
  verifyPaymentAgainstQuote,
  verifySignedPaymentAgainstQuote,
} from "@/lib/stellar/verify-payment-quote";
import type { AuditEntry } from "@/lib/types/domain";

function mockAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  const quote = buildPaymentQuoteFromDecision({
    destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amountXLM: 10,
    actionId: "act-1",
  });
  // Older entries have no fixed expiry and use their audit timestamp.
  if (overrides.timestamp && !overrides.paymentQuote) delete quote.expiresAt;
  return {
    id: "audit-1",
    timestamp: new Date().toISOString(),
    action: {
      id: "act-1",
      name: "Test payment",
      kind: "api_payment",
      target: "svc:endpoint",
      domain: "api.example.com",
      amountXLM: 10,
    },
    decision: "APPROVE",
    explanation: "Approved",
    triggeredPolicies: [],
    riskFindings: [],
    paymentQuote: quote,
    ...overrides,
  };
}

describe("verifyPaymentAgainstQuote", () => {
  it("accepts a matching build request", () => {
    const entry = mockAuditEntry();
    const result = verifyPaymentAgainstQuote(entry, {
      destination: entry.paymentQuote!.destination,
      amountXLM: entry.paymentQuote!.amountXLM,
      asset: "native",
      memo: entry.paymentQuote!.memo,
      network: "testnet",
    });

    expect(result.ok).toBe(true);
  });

  it("uses the injected clock and fixed expiry at submit", () => {
    const nowMs = Date.parse("2026-09-30T12:00:00.000Z");
    const entry = mockAuditEntry({
      paymentQuote: buildPaymentQuoteFromDecision({
        destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        amountXLM: 10,
        actionId: "act-1",
        nowMs,
      }),
    });
    const expiresAt = entry.paymentQuote!.expiresAt!;
    expect(isPaymentDecisionCurrent(entry, entry.id, expiresAt, Date.parse(expiresAt) - 1)).toBe(
      true
    );
    expect(isPaymentDecisionCurrent(entry, entry.id, expiresAt, Date.parse(expiresAt))).toBe(false);
    expect(isPaymentDecisionCurrent(entry, "different-decision", expiresAt, nowMs)).toBe(false);
  });

  it("rejects blocked decisions", () => {
    const entry = mockAuditEntry({ decision: "BLOCK", paymentQuote: undefined });
    const result = verifyPaymentAgainstQuote(entry, {
      destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      amountXLM: "10.0000000",
      asset: "native",
      memo: "fortexa:act-1",
      network: "testnet",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain("BLOCK");
    }
  });
});

describe("normalizeAmountXLM", () => {
  it("formats numeric and string amounts consistently", () => {
    expect(normalizeAmountXLM(18)).toBe("18.0000000");
    expect(normalizeAmountXLM("18")).toBe("18.0000000");
    expect(normalizeAmountXLM("18.5")).toBe("18.5000000");
  });
});

describe("buildPaymentQuoteFromDecision", () => {
  it("derives memo from action id when omitted", () => {
    const quote = buildPaymentQuoteFromDecision({
      destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      amountXLM: 12,
      actionId: "act-99",
    });

    expect(quote.memo).toBe("fortexa:act-99");
    expect(quote.amountXLM).toBe("12.0000000");
    expect(quote.asset).toBe("native");
    expect(quote.network).toBe("testnet");
  });
});

const QUOTE_DESTINATION = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const QUOTE_MEMO = "fortexa:act-1";

/**
 * Builds and signs a real Stellar envelope locally. Nothing here touches
 * Horizon: the transaction is built on an in-memory account and signed with a
 * freshly generated keypair, then handed to the verifier as base64 XDR.
 */
function buildSignedPaymentXdr(
  configure: (builder: TransactionBuilder) => void = (builder) => {
    builder.addOperation(
      Operation.payment({
        destination: QUOTE_DESTINATION,
        asset: Asset.native(),
        amount: "10",
      })
    );
  },
  options: { memo?: Memo; signer?: Keypair } = {}
): string {
  const signer = options.signer ?? Keypair.random();
  const account = new Account(signer.publicKey(), "1");
  const builder = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    memo: options.memo ?? Memo.text(QUOTE_MEMO),
  });

  configure(builder);

  const transaction = builder.setTimeout(180).build();
  transaction.sign(signer);

  return transaction.toXDR();
}

describe("verifySignedPaymentAgainstQuote", () => {
  afterEach(() => {
    delete process.env.FORTEXA_PAYMENT_QUOTE_TTL_SECONDS;
  });

  it("accepts a signed payment that matches asset, amount, destination, and memo", () => {
    const result = verifySignedPaymentAgainstQuote(mockAuditEntry(), buildSignedPaymentXdr());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.amountStroops).toBe(100_000_000n);
      expect(result.quote.destination).toBe(QUOTE_DESTINATION);
    }
  });

  it("compares the amount in integer stroops and rejects a one-stroop difference", () => {
    const entry = mockAuditEntry();

    // Same XLM value written with different trailing zeros still matches.
    const exact = verifySignedPaymentAgainstQuote(
      entry,
      buildSignedPaymentXdr((builder) => {
        builder.addOperation(
          Operation.payment({
            destination: QUOTE_DESTINATION,
            asset: Asset.native(),
            amount: "10.0000000",
          })
        );
      })
    );
    expect(exact.ok).toBe(true);

    // One stroop finer than the authorized amount: `10.0000001`.
    const off = verifySignedPaymentAgainstQuote(
      entry,
      buildSignedPaymentXdr((builder) => {
        builder.addOperation(
          Operation.payment({
            destination: QUOTE_DESTINATION,
            asset: Asset.native(),
            amount: "10.0000001",
          })
        );
      })
    );

    expect(off.ok).toBe(false);
    if (!off.ok) {
      expect(off.status).toBe(403);
      expect(off.field).toBe("amountStroops");
    }
  });

  it("rejects a transaction that bundles an extra operation", () => {
    const result = verifySignedPaymentAgainstQuote(
      mockAuditEntry(),
      buildSignedPaymentXdr((builder) => {
        builder.addOperation(
          Operation.payment({
            destination: QUOTE_DESTINATION,
            asset: Asset.native(),
            amount: "10",
          })
        );
        builder.addOperation(
          Operation.payment({
            destination: QUOTE_DESTINATION,
            asset: Asset.native(),
            amount: "1",
          })
        );
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.field).toBe("operations");
    }
  });

  it("rejects a transaction whose only operation is not a payment", () => {
    const result = verifySignedPaymentAgainstQuote(
      mockAuditEntry(),
      buildSignedPaymentXdr((builder) => {
        builder.addOperation(Operation.manageData({ name: "drained", value: "elsewhere" }));
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.field).toBe("operations");
    }
  });

  it("rejects an expired quote before inspecting the signed transaction", () => {
    process.env.FORTEXA_PAYMENT_QUOTE_TTL_SECONDS = "300";
    const entry = mockAuditEntry({
      timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    });

    const result = verifySignedPaymentAgainstQuote(entry, "not-even-checked");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain("expired");
    }
  });

  it("rejects a destination that does not match the quote", () => {
    const result = verifySignedPaymentAgainstQuote(
      mockAuditEntry(),
      buildSignedPaymentXdr((builder) => {
        builder.addOperation(
          Operation.payment({
            destination: Keypair.random().publicKey(),
            asset: Asset.native(),
            amount: "10",
          })
        );
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.field).toBe("destination");
    }
  });

  it("rejects a non-native asset", () => {
    const issuer = Keypair.random().publicKey();
    const result = verifySignedPaymentAgainstQuote(
      mockAuditEntry(),
      buildSignedPaymentXdr((builder) => {
        builder.addOperation(
          Operation.payment({
            destination: QUOTE_DESTINATION,
            asset: new Asset("USD", issuer),
            amount: "10",
          })
        );
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.field).toBe("asset");
    }
  });

  it("rejects a non-text memo even when the value looks the same", () => {
    const result = verifySignedPaymentAgainstQuote(
      mockAuditEntry(),
      buildSignedPaymentXdr(undefined, { memo: Memo.id("1") })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.field).toBe("memo");
    }
  });

  it("rejects a text memo whose value differs from the quote", () => {
    const result = verifySignedPaymentAgainstQuote(
      mockAuditEntry(),
      buildSignedPaymentXdr(undefined, {
        memo: Memo.text("fortexa:someone-else"),
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.field).toBe("memo");
    }
  });

  it("rejects malformed XDR without throwing", () => {
    const result = verifySignedPaymentAgainstQuote(mockAuditEntry(), "not-a-valid-xdr");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.field).toBe("signedXdr");
    }
  });

  it("rejects a missing decision or a non-executable decision", () => {
    const noEntry = verifySignedPaymentAgainstQuote(undefined, buildSignedPaymentXdr());
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) {
      expect(noEntry.status).toBe(403);
    }

    const blocked = verifySignedPaymentAgainstQuote(
      mockAuditEntry({ decision: "BLOCK", paymentQuote: undefined }),
      buildSignedPaymentXdr()
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.status).toBe(403);
      expect(blocked.error).toContain("BLOCK");
    }
  });

  it("verifies the inner transaction of a fee-bump envelope", () => {
    const innerSource = Keypair.random();
    const feePayer = Keypair.random();
    const account = new Account(innerSource.publicKey(), "1");
    const innerTx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: QUOTE_DESTINATION,
          asset: Asset.native(),
          amount: "10",
        })
      )
      .addMemo(Memo.text(QUOTE_MEMO))
      .setTimeout(180)
      .build();
    innerTx.sign(innerSource);

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feePayer,
      "200",
      innerTx,
      Networks.TESTNET
    );
    feeBumpTx.sign(feePayer);

    const result = verifySignedPaymentAgainstQuote(mockAuditEntry(), feeBumpTx.toXDR());

    expect(result.ok).toBe(true);
  });
});
