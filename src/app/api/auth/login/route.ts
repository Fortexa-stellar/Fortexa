import { readJsonBody } from "@/lib/http/read-json-body";
import { NextRequest } from "next/server";
import { z } from "zod";

import { clearLoginFailures, isLoginLocked, readClientIp, registerLoginFailure } from "@/lib/auth/login-lockout";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { verifyWalletChallenge } from "@/lib/auth/wallet-challenge";
import { normalizeWalletPublicKey, resolveRoleByWallet } from "@/lib/auth/wallet-role";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logError, logInfo, logWarn } from "@/lib/observability/logger";
import { consumeRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";
import { logValidationFailure, toPublicValidationDetails } from "@/lib/validation/errors";

const loginSchema = z.object({
  publicKey: z.string().regex(/^G[A-Z2-7]{55}$/u, "Invalid Stellar public key."),
  challengeId: z.string().uuid("Challenge id required."),
  signature: z.string().min(1, "Wallet signature is required."),
});

const LOCKED_ERROR = "Account login is temporarily locked due to failed attempts.";

function challengeErrorMessage(code: "missing" | "expired" | "replayed" | "wallet_mismatch" | "invalid_signature") {
  switch (code) {
    case "expired":
      return "Login challenge expired. Request a new challenge and sign again.";
    case "replayed":
      return "Login challenge was already used. Request a new challenge and sign again.";
    case "wallet_mismatch":
      return "Challenge does not match the connected wallet.";
    case "invalid_signature":
      return "Wallet signature verification failed.";
    default:
      return "Login challenge is invalid or expired.";
  }
}

function lockedResponse(retryAfterSeconds: number) {
  return {
    error: LOCKED_ERROR,
    retryAfterSeconds: Math.max(1, retryAfterSeconds),
  };
}

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/auth/login");
  const clientIp = readClientIp(request.headers);
  let requestBody: unknown;
  const respond: typeof jsonWithRequestContext = (incoming, input) =>
    jsonWithRequestContext(incoming, {
      ...input,
      logExchange: true,
      requestBody,
    });

  const rate = await consumeRateLimit(request, {
    key: "auth-login",
    limit: 15,
    windowMs: 60_000,
  });

  if (!rate.ok) {
    logWarn("Auth login rate limited", context);
    return respond(request, {
      route: "/api/auth/login",
      startedAtMs,
      status: 429,
      body: { error: "Too many login attempts. Try again later.", code: "rate_limited" },
      headers: rateLimitHeaders(rate),
    });
  }

  try {
    const rawBody = (await request.json().catch(() => ({}))) as unknown;
    requestBody = rawBody;
    const parsed = loginSchema.safeParse(rawBody);

    if (!parsed.success) {
      logValidationFailure("Auth login validation failed", context, parsed.error, rawBody);
      return respond(request, {
        route: "/api/auth/login",
        startedAtMs,
        status: 400,
        body: {
          error: "Invalid login payload.",
          code: "invalid_payload",
          details: toPublicValidationDetails(parsed.error),
        },
        headers: rateLimitHeaders(rate),
      });
    }

    const normalizedWallet = normalizeWalletPublicKey(parsed.data.publicKey);
    const userId = `wallet:${normalizedWallet}`;

    const lockState = await isLoginLocked(userId, clientIp);
    if (lockState.locked) {
      logWarn("Auth login blocked by lockout", { ...context, wallet: normalizedWallet, ip: clientIp });
      return respond(request, {
        route: "/api/auth/login",
        startedAtMs,
        status: 423,
        body: lockedResponse(lockState.retryAfterSeconds),
        headers: {
          ...rateLimitHeaders(rate),
          "Retry-After": String(Math.max(1, lockState.retryAfterSeconds)),
        },
      });
    }

    const challengeResult = await verifyWalletChallenge({
      challengeId: parsed.data.challengeId,
      publicKey: normalizedWallet,
      signature: parsed.data.signature,
    });

    if (!challengeResult.ok) {
      const countsAsFailure = challengeResult.code === "invalid_signature";
      const failure = countsAsFailure ? await registerLoginFailure(userId, clientIp) : null;

      logWarn("Auth login challenge verification failed", {
        ...context,
        wallet: normalizedWallet,
        code: challengeResult.code,
      });

      return respond(request, {
        route: "/api/auth/login",
        startedAtMs,
        status: challengeResult.code === "invalid_signature" ? 401 : 400,
        body: { error: challengeErrorMessage(challengeResult.code) },
        headers: rateLimitHeaders(rate),
      });
    }

    const roles = resolveRolesByWallet(normalizedWallet);

    if (!role) {
      const failure = await registerLoginFailure(userId, clientIp);
      logWarn("Auth login unknown wallet", { ...context, wallet: normalizedWallet });
      return respond(request, {
        route: "/api/auth/login",
        startedAtMs,
        status: 401,
        body: { error: "Wallet is not authorized." },
        headers: rateLimitHeaders(rate),
      });
    }

    await upsertUserWallet(userId, {
      publicKey: normalizedWallet,
      source: "external",
      provider: "login",
    });

    const session = startSession({
      email: `wallet:${normalizedWallet}`,
      role: roles.includes("operator") ? "operator" : roles[0],
      roles,
      userId,
      publicKey: normalizedWallet,
    });

    const response = respond(request, {
      route: "/api/auth/login",
      startedAtMs,
      status: 200,
      body: {
        ok: true,
        role: roles.includes("operator") ? "operator" : roles[0],
        roles,
        wallet: normalizedWallet,
      },
      headers: rateLimitHeaders(rate),
      // The response sets a session cookie, so it must never be cached.
      noStore: true,
    });

    setSessionCookie(response, session.token);

    await clearLoginFailures(userId, clientIp);

    logInfo("Auth login success", { ...context, wallet: normalizedWallet, role });

    return response;
  } catch (error) {
    if (error instanceof WalletAlreadyBoundError) {
      return jsonWithRequestContext(request, {
        route: "/api/auth/login",
        startedAtMs,
        status: 409,
        body: { error: error.message },
        headers: rateLimitHeaders(rate),
      });
    }

    logError("Auth login internal error", {
      ...context,
      detail: error instanceof Error ? error.message : "unknown",
    });
    return respond(request, {
      route: "/api/auth/login",
      startedAtMs,
      status: 500,
      body: { error: error instanceof Error ? error.message : "Login failed.", code: "internal_error" },
      headers: rateLimitHeaders(rate),
    });
  }
}
