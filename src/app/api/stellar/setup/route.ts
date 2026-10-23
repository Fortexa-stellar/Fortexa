import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { getWalletFromSession } from "@/lib/auth/session-wallet";
import { getRequestLogContext, logWarn } from "@/lib/observability/logger";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { STELLAR_PUBLIC_NETWORK_PASSPHRASE } from "@/lib/stellar/network";
import { getStellarNetworkPassphrase } from "@/lib/stellar/network-config";
import { getUserWallet, upsertUserWallet } from "@/lib/storage/user-wallet-store";
import { stellarSetupRequestSchema } from "@/lib/validation/schemas";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const context = getRequestLogContext(request, "/api/stellar/setup");
  const rate = await consumeRateLimit(request, {
    key: "stellar-setup",
    limit: 20,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded for wallet setup." },
      { status: 429, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }

  try {
    const rawBody = (await request.json().catch(() => ({}))) as unknown;
    const parsedBody = stellarSetupRequestSchema.safeParse(rawBody);

    if (!parsedBody.success) {
      logValidationFailure(
        "Stellar setup validation failed",
        { route: "/api/stellar/setup" },
        parsedBody.error,
        rawBody
      );
      return NextResponse.json(
        {
          error: "Invalid wallet setup request.",
          details: toPublicValidationDetails(parsedBody.error),
        },
        {
          status: 400,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    const auth = requireAuth(request);

    if (!auth.ok) {
      return auth.response;
    }

    if (getStellarNetworkPassphrase() === STELLAR_PUBLIC_NETWORK_PASSPHRASE) {
      logWarn("Stellar setup refused on public network", context);
      return NextResponse.json(
        { error: "Stellar setup is disabled on the public network." },
        { status: 403, headers: rateLimitHeaders(rate) }
      );
    }

    const userId = auth.session.userId;
    const assignedWallet = await getUserWallet(userId);

    if (assignedWallet && "expired" in assignedWallet) {
      return NextResponse.json(
        { error: "Session wallet mapping has expired." },
        {
          status: 401,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    const sessionWallet = await getWalletFromSession(auth.session);
    if (!sessionWallet) {
      return NextResponse.json(
        { error: "Session is not bound to a valid Stellar wallet." },
        {
          status: 400,
          headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) },
        }
      );
    }

    await upsertUserWallet(userId, {
      publicKey: sessionWallet,
      source: "external",
      provider: parsedBody.data.provider?.trim() || "login",
    });

    return NextResponse.json(
      {
        ok: true,
        userId,
        source: "external",
        provider: parsedBody.data.provider?.trim() || "login",
        network: "stellar-testnet",
        publicKey: sessionWallet,
        message: "Session wallet synced for transaction execution.",
      },
      { headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  } catch (error) {
    if (error instanceof WalletAlreadyBoundError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: rateLimitHeaders(rate) }
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to setup Stellar testnet wallet." },
      { status: 500, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }
}
