import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { createWalletChallenge } from "@/lib/auth/wallet-challenge";
import { generateChallenge } from "@/lib/auth/challenge";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";

const challengeSchema = z.object({
  publicKey: z.string().regex(/^G[A-Z2-7]{55}$/u, "Invalid Stellar public key."),
});

export async function GET() {
  try {
    const challenge = generateChallenge();
    return NextResponse.json({ challenge });
  } catch {
    return NextResponse.json({ error: "Failed to generate challenge" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/auth/challenge");

  const rate = await consumeRateLimit(request, {
    key: "auth-challenge",
    limit: 30,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    logWarn("Auth challenge rate limited", context);
    return jsonWithRequestContext(request, {
      route: "/api/auth/challenge",
      startedAtMs,
      status: 429,
      body: { error: "Too many challenge requests. Try again later." },
      headers: rateLimitHeaders(rate),
    });
  }

  try {
    const rawBody = (await request.json().catch(() => ({}))) as unknown;
    const parsed = challengeSchema.safeParse(rawBody);

    if (!parsed.success) {
      logValidationFailure("Auth challenge validation failed", context, parsed.error, rawBody);
      return jsonWithRequestContext(request, {
        route: "/api/auth/challenge",
        startedAtMs,
        status: 400,
        body: {
          error: "Invalid challenge payload.",
          details: toPublicValidationDetails(parsed.error),
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const challenge = await createWalletChallenge(parsed.data.publicKey);

    logInfo("Auth challenge created", {
      ...context,
      wallet: challenge.publicKey,
      challengeId: challenge.id,
    });

    return jsonWithRequestContext(request, {
      route: "/api/auth/challenge",
      startedAtMs,
      status: 200,
      body: {
        challengeId: challenge.id,
        message: challenge.message,
        publicKey: challenge.publicKey,
        expiresAt: new Date(challenge.expiresAtMs).toISOString(),
      },
      headers: rateLimitHeaders(rate),
    });
  } catch (error) {
    logError("Auth challenge internal error", {
      ...context,
      detail: error instanceof Error ? error.message : "unknown",
    });
    return jsonWithRequestContext(request, {
      route: "/api/auth/challenge",
      startedAtMs,
      status: 500,
      body: { error: error instanceof Error ? error.message : "Challenge creation failed." },
      headers: rateLimitHeaders(rate),
    });
  }
}
