import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { checkBlocklist } from "@/lib/security/blocklist";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { verifyPaymentAgainstQuote } from "@/lib/stellar/verify-payment-quote";
import { getAuditEntryById } from "@/lib/storage/audit-store";
import { stellarBuildPaymentRequestSchema } from "@/lib/validation/schemas";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";

export async function POST(request: NextRequest) {
  const rate = await consumeRateLimit(request, {
    key: "stellar-pay-legacy",
    limit: 20,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded for legacy pay endpoint." },
      { status: 429, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }

  try {
    const auth = requireAuth(request, { allowedRoles: ["signer"] });

    if (!auth.ok) {
      return auth.response;
    }

    const userId = auth.session.userId;
    const notReady = await readinessBlockResponse(
      request,
      "/api/stellar/pay",
      Date.now(),
      rateLimitHeaders(rate)
    );
    if (notReady) {
      return notReady;
    }
    const rawPayload = (await request.json().catch(() => ({}))) as unknown;
    if (isLoginAuthorizationPayload(rawPayload)) {
      return NextResponse.json(
        { error: "Login signatures cannot authorize a payment." },
        { status: 400, headers: rateLimitHeaders(rate) }
      );
    }

    const parsedPayload = stellarBuildPaymentRequestSchema.safeParse(rawPayload);

    if (!parsedPayload.success) {
      logValidationFailure(
        "Stellar pay validation failed",
        { route: "/api/stellar/pay", userId },
        parsedPayload.error,
        rawPayload
      );
      return NextResponse.json(
        {
          error: "Invalid pay request body.",
          details: toPublicValidationDetails(parsedPayload.error),
        },
        {
          status: 400,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    const payload = parsedPayload.data;

    if (!(await checkBlocklist(payload.destination)).allow) {
      return NextResponse.json(
        { error: "Destination is blocklisted." },
        { status: 403, headers: rateLimitHeaders(rate) }
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
        { error: verification.error, field: verification.field },
        { status: verification.status, headers: rateLimitHeaders(rate) }
      );
    }

    return NextResponse.json(
      {
        error:
          "Direct pay endpoint is disabled. Use wallet-agnostic signed-XDR flow: /api/stellar/build-payment + /api/stellar/submit-signed.",
        userId,
      },
      { status: 400, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Payment failed." },
      { status: 500, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }
}
