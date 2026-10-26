import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { securityHeadersForRequest } from "@/lib/security/headers";
import { revokeUserWallet } from "@/lib/storage/user-wallet-store";

export async function DELETE(request: NextRequest) {
  const rate = await consumeRateLimit(request, {
    key: "stellar-wallet-revoke",
    limit: 10,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded for wallet revocation." },
      { status: 429, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }

  try {
    const auth = requireAuth(request, { allowedRoles: ["operator"] });

    if (!auth.ok) {
      return auth.response;
    }

    const userId = auth.session.userId;

    await revokeUserWallet(userId);

    return NextResponse.json(
      {
        ok: true,
        message: "Session wallet mapping has been successfully revoked.",
      },
      { headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to revoke wallet mapping." },
      { status: 500, headers: { ...rateLimitHeaders(rate), ...securityHeadersForRequest(request) } }
    );
  }
}
