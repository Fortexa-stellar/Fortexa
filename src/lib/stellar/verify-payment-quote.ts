import { createHash } from "node:crypto";

import { validateRequestTimestamp } from "@/lib/stellar/request-timestamp-skew";
import {
  parseXlmNumberToStroops,
  parseXlmToStroops,
  stroopsToXlmString,
  STROOPS_PER_XLM,
} from "@/lib/stellar/stroops";
import type {
  AuditEntry,
  PaymentQuote,
  StellarAssetId,
  StellarNetworkId,
} from "@/lib/types/domain";

export type PaymentQuoteField =
  | "destination"
  | "amountXLM"
  | "asset"
  | "memo"
  | "network";

export type PaymentBuildParams = {
  destination: string;
  amountXLM: string;
  asset: StellarAssetId;
  memo?: string;
  network: StellarNetworkId;
};

export type VerifyPaymentQuoteResult =
  | { ok: true; quote: PaymentQuote }
  | {
      ok: false;
      status: 400 | 403;
      error: string;
      field?: PaymentQuoteField;
    };

const EXECUTABLE_DECISIONS = new Set(["APPROVE", "WARN"]);

export const MAX_PAYMENT_AMOUNT_XLM = 100_000;
const PAYMENT_AMOUNT_DECIMAL_PLACES = 7;
export const PAYMENT_AMOUNT_ERROR =
  "amountXLM must be a positive finite XLM amount with up to 7 decimals.";

const MAX_PAYMENT_AMOUNT_STROOPS =
  BigInt(MAX_PAYMENT_AMOUNT_XLM) * STROOPS_PER_XLM;

/**
 * Reads an authorized amount as an exact stroop count, or `null` if it is not
 * one. Amounts are never scaled in floating point: a value finer than a stroop
 * is refused rather than rounded, because rounding would change the amount the
 * user actually authorized.
 */
function toAuthorizedStroops(amount: number | string): bigint | null {
  const parsed =
    typeof amount === "number"
      ? parseXlmNumberToStroops(amount)
      : parseXlmToStroops(amount);

  if (!parsed.ok) {
    return null;
  }

  if (parsed.stroops <= 0n || parsed.stroops > MAX_PAYMENT_AMOUNT_STROOPS) {
    return null;
  }

  return parsed.stroops;
}

export function isValidPaymentAmountNumber(amount: number): boolean {
  return toAuthorizedStroops(amount) !== null;
}

export function isValidPaymentAmountString(amount: string): boolean {
  // The wire format stays deliberately narrow: unsigned, no exponent notation,
  // and at most 7 written decimals. The value itself is then read exactly.
  if (!/^\d+(?:\.\d+)?$/.test(amount)) {
    return false;
  }

  const [, fraction = ""] = amount.split(".");
  if (fraction.length > PAYMENT_AMOUNT_DECIMAL_PLACES) {
    return false;
  }

  return toAuthorizedStroops(amount) !== null;
}

/** Default quote TTL: 300 seconds (5 minutes). */
const DEFAULT_QUOTE_TTL_SECONDS = 300;

/**
 * Returns the payment quote TTL in seconds.
 * Reads FORTEXA_PAYMENT_QUOTE_TTL_SECONDS; falls back to 300 s when the
 * value is absent, non-numeric, or less than 1.
 */
export function getQuoteTtlMs(): number {
  const parsed = Number(
    process.env.FORTEXA_PAYMENT_QUOTE_TTL_SECONDS ?? DEFAULT_QUOTE_TTL_SECONDS,
  );
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_QUOTE_TTL_SECONDS;
  }
  return Math.floor(parsed);
}

/**
 * Shared "is this decision still allowed to spend?" gate: the quote must be
 * present on the entry and still within its TTL window. Freshness is measured
 * with the shared clock-skew primitive (issue #185) rather than a bespoke
 * `Date.now()` subtraction, so the quote expires on the same boundary the rest
 * of the payment flow uses. A quote timestamp that is unparseable, or dated
 * implausibly far in the future, is refused for the same reason.
 */
function assertQuoteFreshAndPresent(auditEntry: AuditEntry): VerifyPaymentQuoteResult {
  const freshness = validateRequestTimestamp(Date.parse(auditEntry.timestamp), {
    maxPastSkewSeconds: getQuoteTtlSeconds(),
  });

  if (!freshness.ok) {
    if (freshness.code === "stale") {
      return {
        ok: false,
        status: 403,
        error: "Payment quote has expired. Please re-evaluate the action.",
      };
    }
    return {
      ok: false,
      status: 403,
      error: "Payment quote has an invalid timestamp. Please re-evaluate the action.",
      field: "requestTimestampMs",
    };
  }

  const quote = auditEntry.paymentQuote;
  if (!quote) {
    return {
      ok: false,
      status: 403,
      error: "Decision is missing an authorized payment quote.",
    };
  }

  return { ok: true, quote };
}

export function normalizeAmountXLM(amount: number | string): string {
  const parsed = typeof amount === "number" ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid XLM amount.");
  }
  return parsed.toFixed(7);
}

export function buildDecisionReceipt(input: {
  destination: string;
  amountXLM: number | string;
  asset?: StellarAssetId;
  memo?: string;
  network?: StellarNetworkId;
}): PaymentQuote {
  const normalized = {
    destination: input.destination.trim().toUpperCase(),
    amountXLM: normalizeAmountXLM(input.amountXLM),
    asset: input.asset ?? "native",
    memo: (input.memo ?? "").slice(0, 28),
    network: input.network ?? "testnet",
  };

  return {
    ...normalized,
    receiptHash: createHash("sha256")
      .update(JSON.stringify(normalized, Object.keys(normalized).sort()))
      .digest("hex"),
  };
}

export function buildPaymentQuoteFromDecision(input: {
  destination: string;
  amountXLM: number;
  memo?: string;
  actionId: string;
  network?: StellarNetworkId;
  nowMs?: number;
}): PaymentQuote {
  return buildDecisionReceipt({
    destination: input.destination,
    amountXLM: input.amountXLM,
    memo: input.memo ?? `fortexa:${input.actionId}`,
    network: input.network,
  });
}

export function getQuoteExpiresAt(auditEntry: AuditEntry): string {
  if (auditEntry.paymentQuote?.expiresAt) return auditEntry.paymentQuote.expiresAt;
  const legacyExpiryMs = Date.parse(auditEntry.timestamp) + getQuoteTtlMs();
  return Number.isFinite(legacyExpiryMs) ? new Date(legacyExpiryMs).toISOString() : "";
}

export type ValidateDecisionReceiptResult =
  | { ok: true; normalized: PaymentQuote }
  | { ok: false; status?: number; error: string; field?: PaymentQuoteField };

export function validateDecisionReceipt(
  receipt: PaymentQuote,
): ValidateDecisionReceiptResult {
  if (
    !receipt?.destination ||
    !receipt?.amountXLM ||
    !receipt?.asset ||
    !receipt?.memo ||
    !receipt?.network
  ) {
    return {
      ok: false,
      status: 400,
      error: "Payment decision receipt is missing required fields.",
      field: "memo",
    };
  }

  try {
    const normalized = {
      destination: receipt.destination.trim().toUpperCase(),
      amountXLM: normalizeAmountXLM(receipt.amountXLM),
      asset: receipt.asset,
      memo: receipt.memo.slice(0, 28),
      network: receipt.network,
    };

    const expectedHash = createHash("sha256")
      .update(JSON.stringify(normalized, Object.keys(normalized).sort()))
      .digest("hex");

    if (receipt.receiptHash && receipt.receiptHash !== expectedHash) {
      return {
        ok: false,
        status: 403,
        error: "Payment decision receipt is corrupted or tampered.",
        field: "amountXLM",
      };
    }

    return {
      ok: true,
      normalized: { ...normalized, receiptHash: expectedHash },
    };
  } catch {
    return {
      ok: false,
      status: 400,
      error: PAYMENT_AMOUNT_ERROR,
      field: "amountXLM",
    };
  }
}

export function verifyPaymentAgainstQuote(
  auditEntry: AuditEntry | undefined,
  request: PaymentBuildParams,
  nowMs = Date.now(),
): VerifyPaymentQuoteResult {
  if (!auditEntry) {
    return {
      ok: false,
      status: 403,
      error: "No authorized payment decision found for this request.",
    };
  }

  if (!EXECUTABLE_DECISIONS.has(auditEntry.decision)) {
    return {
      ok: false,
      status: 403,
      error: `Decision '${auditEntry.decision}' does not authorize payment execution.`,
    };
  }

  if (request.requestTimestampMs !== undefined) {
    const skewResult = validateRequestTimestamp(request.requestTimestampMs, { nowMs });
    if (!skewResult.ok) {
      const reason =
        skewResult.code === "stale"
          ? "too old"
          : skewResult.code === "future"
            ? "too far in the future"
            : "not a valid timestamp";
      return {
        ok: false,
        status: 400,
        error: `Request timestamp is ${reason}.`,
        field: "requestTimestampMs",
      };
    }
  }

  const expiresAtMs = Date.parse(getQuoteExpiresAt(auditEntry));
  if (!Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs) {
    return {
      ok: false,
      status: 403,
      error: "Payment quote has expired. Please re-evaluate the action.",
    };
  }

  const { quote } = gate;

  const normalizedRequest = {
    destination: request.destination.trim().toUpperCase(),
    amountXLM: normalizeAmountXLM(request.amountXLM),
    asset: request.asset,
    memo: (request.memo ?? quote.memo).slice(0, 28),
    network: request.network,
  };

  if (normalizedRequest.destination !== quote.destination) {
    return {
      ok: false,
      status: 403,
      error: "Destination does not match the authorized payment quote.",
      field: "destination",
    };
  }

  if (normalizedRequest.amountXLM !== quote.amountXLM) {
    return {
      ok: false,
      status: 403,
      error: "Amount does not match the authorized payment quote.",
      field: "amountXLM",
    };
  }

  if (normalizedRequest.asset !== quote.asset) {
    return {
      ok: false,
      status: 403,
      error: "Asset does not match the authorized payment quote.",
      field: "asset",
    };
  }

  if (normalizedRequest.memo !== quote.memo) {
    return {
      ok: false,
      status: 403,
      error: "Memo does not match the authorized payment quote.",
      field: "memo",
    };
  }

  if (!quote.memo || quote.memo.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "Memo is required for this payment destination.",
      field: "memo",
    };
  }

  if (normalizedRequest.network !== quote.network) {
    return {
      ok: false,
      status: 403,
      error: "Network does not match the authorized payment quote.",
      field: "network",
    };
  }

  return { ok: true, quote };
}

/** Fields a signed-transaction verification can point at on failure. */
export type SignedPaymentField =
  | "amountStroops"
  | "asset"
  | "destination"
  | "memo"
  | "operations"
  | "signedXdr";

export type VerifySignedPaymentQuoteResult =
  | { ok: true; quote: PaymentQuote; amountStroops: bigint }
  | {
      ok: false;
      status: 400 | 403;
      error: string;
      field?: SignedPaymentField;
    };

/**
 * Reads the text of a transaction memo, or `null` when the memo is not a text
 * memo. A decoded memo carries its text as a UTF-8 `Buffer`, while one built
 * in-process still carries the original string, so both shapes are normalized.
 */
function readTextMemoValue(memo: Memo): string | null {
  if (memo.type !== MemoText) {
    return null;
  }

  const value = memo.value;
  if (typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  return null;
}

/**
 * Verifies a *signed* payment transaction against the immutable quote stored on
 * the audit entry, decoding the XDR in-process without ever contacting Horizon.
 *
 * The comparison runs in integer stroops on the decoded operation and requires
 * the envelope to contain exactly one operation, and that operation to be a
 * payment, so a caller cannot smuggle a second spend into a transaction that was
 * authorized for a single payment. Asset, destination, memo type, memo value,
 * and amount must all equal the stored quote; a one-stroop difference is a
 * mismatch. The quote's freshness is checked with the shared clock-skew helper
 * before the envelope is even decoded.
 *
 * @param auditEntry - The decision receipt whose `paymentQuote` was approved.
 * @param signedXdr - Base64 envelope XDR of the signed payment to verify.
 * @param options.networkPassphrase - Override for the configured network
 *   passphrase, primarily for deterministic tests.
 */
export function verifySignedPaymentAgainstQuote(
  auditEntry: AuditEntry | undefined,
  signedXdr: string,
  options: { networkPassphrase?: string } = {},
): VerifySignedPaymentQuoteResult {
  if (typeof signedXdr !== "string" || signedXdr.trim().length === 0) {
    return {
      ok: false,
      status: 400,
      error: "A signed transaction XDR is required.",
      field: "signedXdr",
    };
  }

  if (!auditEntry) {
    return {
      ok: false,
      status: 403,
      error: "No authorized payment decision found for this request.",
    };
  }

  if (!EXECUTABLE_DECISIONS.has(auditEntry.decision)) {
    return {
      ok: false,
      status: 403,
      error: `Decision '${auditEntry.decision}' does not authorize payment execution.`,
    };
  }

  const gate = assertQuoteFreshAndPresent(auditEntry);
  if (!gate.ok) {
    return gate;
  }
  const { quote } = gate;

  const networkPassphrase =
    options.networkPassphrase ?? getStellarNetworkPassphrase();

  let decoded: Transaction | FeeBumpTransaction;
  try {
    decoded = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    return {
      ok: false,
      status: 400,
      error:
        "Signed transaction XDR could not be decoded. It may be malformed or built for the wrong network.",
      field: "signedXdr",
    };
  }

  // A fee-bump envelope pays the fee from a second account but still carries the
  // payment in its inner transaction, so verify the inner transaction either way.
  const transaction =
    decoded instanceof FeeBumpTransaction ? decoded.innerTransaction : decoded;

  const operations = transaction.operations;
  if (operations.length !== 1) {
    return {
      ok: false,
      status: 403,
      error:
        "Signed transaction must contain exactly one operation: the authorized payment.",
      field: "operations",
    };
  }

  const operation = operations[0];
  if (operation.type !== "payment") {
    return {
      ok: false,
      status: 403,
      error: "Signed transaction's only operation is not a payment.",
      field: "operations",
    };
  }

  if (operation.destination.trim().toUpperCase() !== quote.destination) {
    return {
      ok: false,
      status: 403,
      error: "Destination does not match the authorized payment quote.",
      field: "destination",
    };
  }

  if (quote.asset !== "native" || !operation.asset.isNative()) {
    return {
      ok: false,
      status: 403,
      error: "Asset does not match the authorized payment quote.",
      field: "asset",
    };
  }

  const transactionStroops = parseXlmToStroops(operation.amount);
  const quoteStroops = parseXlmToStroops(quote.amountXLM);
  if (!transactionStroops.ok || !quoteStroops.ok) {
    return {
      ok: false,
      status: 403,
      error: "Payment amount could not be read as an exact stroop count.",
      field: "amountStroops",
    };
  }

  if (transactionStroops.stroops !== quoteStroops.stroops) {
    return {
      ok: false,
      status: 403,
      error:
        `Payment amount ${stroopsToXlmString(transactionStroops.stroops)} XLM does not match the ` +
        `authorized amount ${quote.amountXLM} XLM.`,
      field: "amountStroops",
    };
  }

  const memoText = readTextMemoValue(transaction.memo);
  if (memoText === null || memoText !== quote.memo) {
    return {
      ok: false,
      status: 403,
      error: "Memo does not match the authorized payment quote.",
      field: "memo",
    };
  }

  return { ok: true, quote, amountStroops: transactionStroops.stroops };
}
