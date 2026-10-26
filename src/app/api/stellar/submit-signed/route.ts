import { getTransactionHash, verifyBuildAuthorization } from "@/lib/stellar/payment-build-authorization";
import { isPaymentDecisionCurrent } from "@/lib/stellar/verify-payment-quote";
import { getAuditEntryById } from "@/lib/storage/audit-store";
import { NextRequest } from "next/server";
import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";

import { requireAuth } from "@/lib/auth/require-auth";
import { isLoginAuthorizationPayload } from "@/lib/auth/wallet-challenge";
import { readJsonBody } from "@/lib/http/read-json-body";
import { jsonWithRequestContext } from "@/lib/observability/http";
import {
  getRequestLogContext,
  logError,
  logInfo,
  logWarn,
} from "@/lib/observability/logger";
import { recordStellarSubmitResult } from "@/lib/observability/metrics";
import { redactSensitiveFields } from "@/lib/observability/redact";
import { getProtectedPaymentFlowReadinessReport } from "@/lib/readiness/production";
import { enforceRequestGate, gateErrorHeaders } from "@/lib/security/enforcement-gate";
import { rateLimitHeaders } from "@/lib/security/rate-limit";
import {
  decodeSignedXdrDestination,
  decodeSignedXdrSourceAccount,
  submitSignedTransactionXdr,
  verifySignedXdrSigner,
  type SignedXdrDestinationResult,
} from "@/lib/stellar/client";
import { getStellarExplorerTransactionUrl } from "@/lib/stellar/network";
import { assertStellarNetworkConfig } from "@/lib/stellar/network-config";
import { validateDecisionReceipt } from "@/lib/stellar/verify-payment-quote";
import {
  abortIdempotentSubmit,
  beginIdempotentSubmit,
  completeIdempotentSubmit,
  getIdempotencyInFlightWaitMs,
  hashCanonicalPaymentBody,
  hashSignedXdr,
  maybeRunCleanup,
} from "@/lib/storage/submit-idempotency-store";
import { getUserWallet } from "@/lib/storage/user-wallet-store";
import {
  stellarSubmitSignedRequestSchema,
  validateIdempotencyKey,
} from "@/lib/validation/schemas";
import {
  logValidationFailure,
  toPublicValidationDetails,
} from "@/lib/validation/errors";
import { normalizeHorizonError } from "@/lib/utils/horizonErrors";

type HorizonErrorContext = {
  explanation: string;
  nextStep: string;
};

/**
 * Best-effort destination extraction from a signed XDR for gate checking.
 * Runs before validation; a malformed envelope simply reports no destination
 * (the strict decode later still returns the route's normal 400).
 */
function extractSignedXdrDestination(
  signedXdr: string | undefined,
): SignedXdrDestinationResult {
  if (!signedXdr) {
    return { ok: false, reason: "malformed" };
  }

  try {
    return decodeSignedXdrDestination(signedXdr);
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

const HORIZON_TX_ERRORS: Record<string, HorizonErrorContext> = {
  tx_bad_seq: {
    explanation: "The transaction sequence number is incorrect.",
    nextStep:
      "Refresh your wallet or account data to synchronize the sequence number and try again.",
  },
  tx_insufficient_fee: {
    explanation: "The network fee provided is too low.",
    nextStep: "Increase the transaction fee.",
  },
  tx_insufficient_balance: {
    explanation: "The source account has insufficient balance for this fee.",
    nextStep: "Ensure the account has enough XLM to pay the transaction fee.",
  },
  tx_bad_auth: {
    explanation: "The signature provided is invalid or unauthorized.",
    nextStep: "Re-sign the transaction with the correct wallet.",
  },
  tx_no_source_account: {
    explanation: "The source account does not exist on the network.",
    nextStep: "Fund the account before submitting transactions.",
  },
  tx_too_late: {
    explanation: "The transaction timebounds have expired.",
    nextStep: "Re-build the transaction with a fresh timebound and re-sign.",
  },
};

const HORIZON_OP_ERRORS: Record<string, HorizonErrorContext> = {
  op_no_destination: {
    explanation: "The destination account does not exist.",
    nextStep: "Verify the destination address or ensure the account is funded.",
  },
  op_underfunded: {
    explanation:
      "The source account lacks sufficient funds for this operation.",
    nextStep:
      "Fund the source account with enough XLM to cover the payment and reserves.",
  },
};

function verifySignedXdrMatchesDecisionReceipt(
  signedXdr: string,
  receipt: {
    destination: string;
    amountXLM: string;
    asset: string;
    memo?: string;
    network: string;
    receiptHash?: string;
  },
) {
  const validation = validateDecisionReceipt(receipt as Parameters<typeof validateDecisionReceipt>[0]);
  if (!validation.ok) {
    return {
      ok: false,
      status: 403,
      error: validation.error,
      field: validation.field,
    };
  }

  const { networkPassphrase } = assertStellarNetworkConfig();
  let decoded: ReturnType<typeof TransactionBuilder.fromXDR>;

  try {
    decoded = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  } catch {
    return {
      ok: false,
      status: 400,
      error:
        "Signed XDR could not be decoded. It may be malformed or built for the wrong network.",
    };
  }

  const paymentOp = decoded.operations.find((op: (typeof decoded.operations)[number]) => op.type === "payment");
  if (!paymentOp || paymentOp.type !== "payment") {
    return {
      ok: false,
      status: 403,
      error: "Signed transaction is not a payment operation.",
      field: "destination",
    };
  }

  const network =
    networkPassphrase === "Test SDF Network ; September 2015"
      ? "testnet"
      : "testnet";
  const innerTx = decoded instanceof FeeBumpTransaction ? decoded.innerTransaction : decoded;
  const memoValue = innerTx.memo?.type === "text" ? String(innerTx.memo.value ?? "") : "";

  const actual = {
    destination: paymentOp.destination?.trim().toUpperCase(),
    amountXLM: String(paymentOp.amount ?? "0"),
    asset: "native",
    memo: memoValue,
    network,
  };

  if (actual.destination !== validation.normalized.destination) {
    return {
      ok: false,
      status: 403,
      error:
        "Signed transaction destination does not match the authorized payment decision receipt.",
      field: "destination",
    };
  }

  if (actual.amountXLM !== validation.normalized.amountXLM) {
    return {
      ok: false,
      status: 403,
      error:
        "Signed transaction amount does not match the authorized payment decision receipt.",
      field: "amountXLM",
    };
  }

  if (actual.asset !== validation.normalized.asset) {
    return {
      ok: false,
      status: 403,
      error:
        "Signed transaction asset does not match the authorized payment decision receipt.",
      field: "asset",
    };
  }

  if ((actual.memo || "") !== (validation.normalized.memo || "")) {
    return {
      ok: false,
      status: 403,
      error:
        "Signed transaction memo does not match the authorized payment decision receipt.",
      field: "memo",
    };
  }

  if (actual.network !== validation.normalized.network) {
    return {
      ok: false,
      status: 403,
      error:
        "Signed transaction network does not match the authorized payment decision receipt.",
      field: "network",
    };
  }

  return { ok: true as const };
}

export function formatSubmitError(error: unknown) {
  const defaultExplanation =
    "Horizon rejected the transaction. Review transaction details, balances, or sequence numbers.";
  const defaultNextStep =
    "Check your wallet balance, verify network connectivity, and try again.";

  if (typeof error === "object" && error !== null) {
    const horizonError = error as {
      response?: {
        data?: {
          extras?: {
            result_codes?: {
              transaction?: string;
              operations?: string[];
            };
          };
          title?: string;
          detail?: string;
        };
      };
      message?: string;
    };

    const extras = horizonError.response?.data?.extras;
    const txCode = extras?.result_codes?.transaction;
    const opCodes = extras?.result_codes?.operations;

    let explanation = txCode ? HORIZON_TX_ERRORS[txCode]?.explanation : undefined;
    let nextStep = txCode ? HORIZON_TX_ERRORS[txCode]?.nextStep : undefined;

    if (!explanation && opCodes?.length) {
      for (const code of opCodes) {
        if (HORIZON_OP_ERRORS[code]) {
          explanation = HORIZON_OP_ERRORS[code]?.explanation;
          nextStep = HORIZON_OP_ERRORS[code]?.nextStep;
          break;
        }
      }
    }

    const message =
      horizonError.response?.data?.detail ??
      horizonError.response?.data?.title ??
      horizonError.message ??
      "Transaction submission failed.";

    return {
      message,
      explanation: explanation ?? defaultExplanation,
      nextStep: nextStep ?? defaultNextStep,
      txCode,
      opCodes,
    };
  }

  return {
    message: "Transaction submission failed.",
    explanation: defaultExplanation,
    nextStep: defaultNextStep,
  };
}

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/stellar/submit-signed");
  let requestBody: unknown;
  const requestBodyTooLarge = false;
  const respond: typeof jsonWithRequestContext = (incoming, input) =>
    jsonWithRequestContext(incoming, {
      ...input,
      logExchange: true,
      requestBody,
      requestBodyTooLarge,
    });

  // Read the body before the gate so the signed transaction's destination
  // operations can be blocklist-checked in the same atomic enforcement step
  // as the rate-limit consumption (issue #202).
  const bodyResult = await readJsonBody(request);

  let gateDestination: string | undefined;
  if (bodyResult.ok) {
    const destinationPreview = extractSignedXdrDestination(
      typeof (bodyResult.data as { signedXdr?: unknown })?.signedXdr === "string"
        ? (bodyResult.data as { signedXdr: string }).signedXdr
        : undefined,
    );
    gateDestination = destinationPreview.ok ? destinationPreview.destination : undefined;
  }

  const gate = await enforceRequestGate(request, {
    rateLimitKey: "stellar-submit-signed",
    limit: 30,
    windowMs: 60_000,
    destination: gateDestination,
  });

  if (!gate.ok) {
    logWarn("Submit signed route blocked by enforcement gate", {
      ...context,
      gateCode: gate.code,
    });
    recordStellarSubmitResult("validation_failure");
    return jsonWithRequestContext(request, {
      route: "/api/stellar/submit-signed",
      startedAtMs,
      status: gate.status,
      body: {
        error: gate.error,
        code: gate.code,
      },
      headers: gateErrorHeaders(gate),
    });
  }

  const rate = gate.rate;

  maybeRunCleanup();

  let claimedIdempotency: {
    userId: string;
    key: string;
    requestHash: string;
  } | null = null;

  try {
    const readinessReport = getProtectedPaymentFlowReadinessReport();
    if (readinessReport) {
      logWarn("Submit signed blocked by production readiness check", context);
      return respond(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 503,
        body: {
          error: "Service is not configured for payment execution.",
          code: "not_production_ready",
          issues: readinessReport.issues,
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const auth = requireAuth(request, { allowedRoles: ["signer"] });

    if (!auth.ok) {
      logWarn("Submit signed unauthorized", context);
      return auth.response;
    }

    const userId = auth.session.userId;
    const sessionWallet = auth.session.publicKey;

    if (bodyResult.ok && isLoginAuthorizationPayload(bodyResult.data)) {
      logWarn("Submit signed rejected login payload", { ...context, userId, code: "login_payload" });
      return jsonWithRequestContext(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 400,
        body: { error: "Login signatures cannot authorize a payment." },
        headers: rateLimitHeaders(rate),
      });
    }

    if (!bodyResult.ok) {
      logWarn("Submit signed payload too large", { ...context, userId });
      return jsonWithRequestContext(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 413,
        body: { error: bodyResult.error },
        headers: rateLimitHeaders(rate),
      });
    }

    requestBody = bodyResult.data;
    const parsedPayload = stellarSubmitSignedRequestSchema.safeParse(bodyResult.data);

    if (!parsedPayload.success) {
      logValidationFailure("Submit signed validation failed", { ...context, userId }, parsedPayload.error, bodyResult.data);
      recordStellarSubmitResult("validation_failure");
      return respond(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 400,
        body: {
          error: "Invalid signed transaction submission.",
          details: toPublicValidationDetails(parsedPayload.error),
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const payload = parsedPayload.data;

    const assignedWallet = await getUserWallet(userId);
    if (!assignedWallet || "expired" in assignedWallet) {
      logWarn("Submit signed wallet revoked or expired", { ...context, userId });
      return respond(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 401,
        body: { error: assignedWallet ? "Session wallet mapping has expired or been revoked." : "No session wallet mapping found." },
        headers: rateLimitHeaders(rate),
      });
    }

    const xdrSourceResult = decodeSignedXdrSourceAccount(payload.signedXdr);
    if (!xdrSourceResult.ok) {
      logWarn("Submit signed malformed XDR", { ...context, userId });
      recordStellarSubmitResult("validation_failure");
      return respond(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 400,
        body: {
          error:
            "Signed XDR could not be decoded. It may be malformed or built for the wrong network.",
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const effectiveDecisionId = payload.decisionId ?? payload.auditEntryId;

    if (payload.buildAuthorization && effectiveDecisionId && payload.quoteExpiresAt) {
      const transactionHash = getTransactionHash(
        payload.signedXdr,
        assertStellarNetworkConfig().networkPassphrase,
      );
      if (
        !verifyBuildAuthorization(payload.buildAuthorization, {
          userId,
          decisionId: effectiveDecisionId,
          quoteExpiresAt: payload.quoteExpiresAt,
          transactionHash,
        })
      ) {
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: 403,
          body: { error: "Signed transaction does not match the authorized payment build." },
          headers: rateLimitHeaders(rate),
        });
      }

      const auditEntry = await getAuditEntryById(userId, effectiveDecisionId);
      if (!isPaymentDecisionCurrent(auditEntry, effectiveDecisionId, payload.quoteExpiresAt)) {
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: 403,
          body: { error: "Payment decision or quote is no longer valid. Please re-evaluate the action." },
          headers: rateLimitHeaders(rate),
        });
      }
    } else if (payload.decisionReceipt) {
      const receiptCheck = verifySignedXdrMatchesDecisionReceipt(
        payload.signedXdr,
        payload.decisionReceipt,
      );
      if (!receiptCheck.ok) {
        logWarn("Submit signed XDR disagrees with decision receipt", {
          ...context,
          userId,
          receiptHash: payload.decisionReceipt.receiptHash,
          signedXdrHash: hashSignedXdr(payload.signedXdr),
          field: receiptCheck.field,
        });
        recordStellarSubmitResult("decision_receipt_mismatch");
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: receiptCheck.status ?? 403,
          body: {
            error: receiptCheck.error,
            field: receiptCheck.field,
            receiptHash: payload.decisionReceipt.receiptHash,
          },
          headers: rateLimitHeaders(rate),
        });
      }
    } else if (effectiveDecisionId) {
      const auditEntry = await getAuditEntryById(userId, effectiveDecisionId);
      if (!auditEntry || !auditEntry.paymentQuote) {
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: 403,
          body: { error: "Decision does not authorize payment execution." },
          headers: rateLimitHeaders(rate),
        });
      }
      const quoteCheck = verifySignedXdrMatchesDecisionReceipt(
        payload.signedXdr,
        auditEntry.paymentQuote,
      );
      if (!quoteCheck.ok) {
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: quoteCheck.status ?? 403,
          body: { error: quoteCheck.error ?? "Decision does not authorize payment execution." },
          headers: rateLimitHeaders(rate),
        });
      }
    } else {
      return respond(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 403,
        body: { error: "Decision does not authorize payment execution." },
        headers: rateLimitHeaders(rate),
      });
    }

    if (xdrSourceResult.sourceAccount !== assignedWallet.publicKey) {
      logWarn("Submit signed source wallet mismatch", {
        ...context,
        userId,
        expectedWallet: sessionWallet,
        actualSource: xdrSourceResult.sourceAccount,
      });
      recordStellarSubmitResult("source_wallet_mismatch");
      return respond(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 403,
        body: {
          error: "Signed transaction source account does not match your session wallet.",
        },
        headers: rateLimitHeaders(rate),
      });
    }

    if (sessionWallet && !verifySignedXdrSigner(payload.signedXdr, sessionWallet)) {
      logWarn("Submit signed signer wallet mismatch", {
        ...context,
        userId,
        expectedWallet: sessionWallet,
      });
      recordStellarSubmitResult("signer_wallet_mismatch");
      return respond(request, {
        route: "/api/stellar/submit-signed",
        startedAtMs,
        status: 403,
        body: {
          error: "Signed transaction signer does not match your session wallet.",
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const headerKey = request.headers.get("idempotency-key")?.trim();
    const bodyKey = payload.idempotencyKey?.trim();
    const mergedIdempotencyKey = headerKey && headerKey.length > 0 ? headerKey : bodyKey;

    let idempotencyKey: string | undefined;
    if (mergedIdempotencyKey) {
      const idempotencyValidation = validateIdempotencyKey(mergedIdempotencyKey);
      if (!idempotencyValidation.ok) {
        logWarn("Submit signed invalid idempotency key", {
          ...context,
          userId,
        });
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: 400,
          body: { error: idempotencyValidation.error },
          headers: rateLimitHeaders(rate),
        });
      }
      idempotencyKey = idempotencyValidation.key;
    }

    const requestHash = idempotencyKey
      ? hashCanonicalPaymentBody(idempotencyKey, payload)
      : null;

    if (idempotencyKey && requestHash) {
      const claim = await beginIdempotentSubmit(userId, idempotencyKey, requestHash, {
        inFlightWaitMs: getIdempotencyInFlightWaitMs(),
      });

      if (claim.outcome === "conflict") {
        logWarn("Signed transaction idempotency conflict", { ...context, userId, idempotencyKey });
        recordStellarSubmitResult("idempotency_conflict");
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: 409,
          body: {
            error: "Idempotency-Key was already used with a different signed transaction.",
          },
          headers: { ...rateLimitHeaders(rate), "Idempotency-Replayed": "false" },
        });
      }

      if (claim.outcome === "in_flight") {
        logWarn("Signed transaction idempotency in flight", {
          ...context,
          userId,
          idempotencyKey,
        });
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: 409,
          body: {
            error: "An identical submit for this idempotency key is still in progress.",
            code: "idempotency_in_flight",
          },
          headers: {
            ...rateLimitHeaders(rate),
            "Idempotency-Replayed": "false",
            "Retry-After": "1",
          },
        });
      }

      if (claim.outcome === "replay") {
        logInfo("Signed transaction idempotent replay", {
          ...context,
          userId,
          idempotencyKey,
          transactionHash: claim.record.transactionId,
        });
        recordStellarSubmitResult("idempotency_replay");
        return respond(request, {
          route: "/api/stellar/submit-signed",
          startedAtMs,
          status: claim.record.statusCode ?? 200,
          body: claim.record.result,
          headers: { ...rateLimitHeaders(rate), "Idempotency-Replayed": "true" },
        });
      }

      claimedIdempotency = { userId, key: idempotencyKey, requestHash };
    }

    const submitted = await submitSignedTransactionXdr(payload.signedXdr);

    logInfo("Signed transaction submitted", {
      ...context,
      userId,
      txHash: submitted.hash,
      ledger: submitted.ledger,
    });

    recordStellarSubmitResult("success");

    const responseBody = {
      ok: true,
      userId,
      transactionHash: submitted.hash,
      payment: {
        mode: "real",
        ...submitted,
      },
      explorerUrl: getStellarExplorerTransactionUrl(submitted.hash),
    };

    if (claimedIdempotency) {
      const claim = claimedIdempotency;
      claimedIdempotency = null;

      try {
        await completeIdempotentSubmit(userId, claim.key, claim.requestHash, {
          statusCode: 200,
          transactionId: submitted.hash,
          result: responseBody,
        });
      } catch (settleError) {
        logError("Submit signed idempotency settle failed", {
          ...context,
          userId,
          idempotencyKey: claim.key,
          detail: settleError instanceof Error ? settleError.message : "unknown",
        });
      }
    }

    return respond(request, {
      route: "/api/stellar/submit-signed",
      startedAtMs,
      status: 200,
      body: responseBody,
      headers: idempotencyKey
        ? { ...rateLimitHeaders(rate), "Idempotency-Replayed": "false" }
        : rateLimitHeaders(rate),
    });
  } catch (error) {
    if (claimedIdempotency) {
      const claim = claimedIdempotency;
      claimedIdempotency = null;
      await abortIdempotentSubmit(claim.userId, claim.key, claim.requestHash).catch(
        () => undefined
      );
    }

    const formatted = formatSubmitError(error);
    const category = normalizeHorizonError(formatted.txCode);
    logError("Submit signed internal error", redactSensitiveFields({
      ...context,
      detail: formatted.message,
      horizonCategory: category,
    }));
    recordStellarSubmitResult("horizon_failure");
    return respond(request, {
      route: "/api/stellar/submit-signed",
      startedAtMs,
      status: 500,
      body: {
        error: formatted.message,
        category,
        resultCode: formatted.txCode,
        operationCodes: formatted.opCodes,
        explanation: formatted.explanation,
        nextStep: formatted.nextStep,
        rawError: formatted,
      },
      headers: rateLimitHeaders(rate),
    });
  }
}
