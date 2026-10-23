import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { readJsonBody } from "@/lib/http/read-json-body";
import { getProtectedPaymentFlowReadinessReport } from "@/lib/readiness/production";
import { readinessBlockResponse } from "@/lib/readiness/guard";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { securityHeadersForRequest } from "@/lib/security/headers";
import { buildUnsignedPaymentTransaction } from "@/lib/stellar/client";
import { verifyPaymentAgainstQuote } from "@/lib/stellar/verify-payment-quote";
import { paymentExceedsPerTxCap } from "@/lib/policy/engine";
import { getAuditEntryById } from "@/lib/storage/audit-store";
import { getPolicyConfig } from "@/lib/storage/policy-store";
import { getUserWallet } from "@/lib/storage/user-wallet-store";
import { stellarBuildPaymentRequestSchema } from "@/lib/validation/schemas";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";

export async function POST(request: NextRequest) {
  // Read the body first so the gate can blocklist-check the destination in
  // the same atomic step as the rate-limit consumption (issue #202).
  const bodyResult = await readJsonBody(request);

  let gateDestination: string | undefined;
  if (bodyResult.ok) {
    const preview = stellarBuildPaymentRequestSchema.safeParse(bodyResult.data);
    gateDestination = preview.success ? preview.data.destination : undefined;
  }

  const gate = await enforceRequestGate(request, {
    rateLimitKey: "stellar-build-payment",
    limit: 30,
    windowMs: 60_000,
    destination: gateDestination,
  });

  if (!gate.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded for payment build endpoint." },
      { status: 429, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }

  const rate = gate.rate;

  try {
    const auth = requireAuth(request, { allowedRoles: ["signer"] });

    if (!auth.ok) {
      return auth.response;
    }

    const readinessReport = getProtectedPaymentFlowReadinessReport();
    if (readinessReport) {
      return NextResponse.json(
        {
          error:
            "Protected payment flows are disabled until Fortexa passes the production readiness check.",
          issues: readinessReport.issues,
          command: "npm run check:production-readiness",
        },
        { status: 503, headers: rateLimitHeaders(rate) }
      );
    }
    const notReady = await readinessBlockResponse(
      request,
      "/api/stellar/build-payment",
      Date.now(),
      rateLimitHeaders(rate)
    );
    if (notReady) {
      return notReady;
    }
    const userId = auth.session.userId;
    const assignedWallet = await getUserWallet(userId);

    if (assignedWallet && "expired" in assignedWallet) {
      return NextResponse.json(
        { error: "Session wallet mapping has expired." },
        { status: 401, headers: rateLimitHeaders(rate) }
      );
    }

    if (!bodyResult.ok) {
      return NextResponse.json(
        { error: bodyResult.error },
        {
          status: 413,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    const parsedPayload = stellarBuildPaymentRequestSchema.safeParse(bodyResult.data);

    if (!parsedPayload.success) {
      logValidationFailure(
        "Stellar build payment validation failed",
        { route: "/api/stellar/build-payment", userId },
        parsedPayload.error,
        bodyResult.data
      );
      return NextResponse.json(
        {
          error: "Invalid payment build request.",
          details: parsedPayload.error.flatten(),
        },
        {
          status: 400,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    const payload = parsedPayload.data;

    const sourcePublicKey = assignedWallet?.publicKey;

    if (!sourcePublicKey || assignedWallet?.source !== "external") {
      return NextResponse.json(
        {
          error: "A linked Stellar wallet is required before building transactions.",
        },
        {
          status: 400,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    const auditEntry = await getAuditEntryById(userId, payload.auditEntryId);
    const verification = verifyPaymentAgainstQuote(auditEntry, {
      destination: payload.destination,
      amountXLM: payload.amountXLM,
      asset: payload.asset,
      memo: payload.memo,
      network: payload.network,
    });

    if (!verification.ok) {
      return NextResponse.json(
        {
          error: verification.error,
          field: verification.field,
        },
        {
          status: verification.status,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    const { policy } = await getPolicyConfig();
    if (paymentExceedsPerTxCap(payload.amountXLM, policy)) {
      return NextResponse.json(
        {
          error: "Payment amount exceeds the allowing policy cap.",
          field: "amountXLM",
        },
        { status: 403, headers: rateLimitHeaders(rate) }
      );
    }

    const unsigned = await buildUnsignedPaymentTransaction(
      {
        destination: payload.destination,
        amountXLM: payload.amountXLM,
        memo: verification.quote.memo,
      },
      sourcePublicKey
    );

    const quoteExpiresAt = getQuoteExpiresAt(auditEntry!);
    const buildAuthorization = createBuildAuthorization({
      userId,
      decisionId: auditEntry!.id,
      quoteExpiresAt,
      transactionHash: getTransactionHash(unsigned.xdr, unsigned.networkPassphrase),
    });

    return NextResponse.json(
      {
        ok: true,
        userId,
        source: assignedWallet.source,
        provider: assignedWallet.provider ?? "unknown",
        sourcePublicKey,
        xdr: unsigned.xdr,
        networkPassphrase: unsigned.networkPassphrase,
        decisionReceipt: verification.quote,
        paymentQuote: verification.quote,
      },
      { headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to build payment transaction.",
      },
      { status: 500, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }
}
