import { NextRequest } from "next/server";

import { requireActiveAuth } from "@/lib/auth/require-auth";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { jsonWithRequestContext } from "@/lib/observability/http";
import { getRequestLogContext, logInfo, logWarn } from "@/lib/observability/logger";
import { getUserWallet } from "@/lib/storage/user-wallet-store";
import { isLoginLocked, readClientIp } from "@/lib/auth/login-lockout";

export async function POST(request: NextRequest) {
  const startedAtMs = Date.now();
  const context = getRequestLogContext(request, "/api/auth/refresh");
  // A logged-out session must not be able to mint a new generation.
  const auth = await requireActiveAuth(request);

  if (!auth.ok) {
    logWarn("Auth refresh unauthorized", context);
    return auth.response;
  }

  const clientIp = readClientIp(request.headers);
  const sessionWallet = auth.session.publicKey;

  if (sessionWallet) {
    const lockState = await isLoginLocked(sessionWallet, clientIp);
    if (lockState.locked) {
      logWarn("Auth refresh blocked by lockout", {
        ...context,
        wallet: sessionWallet,
        ip: clientIp,
      });
      return jsonWithRequestContext(request, {
        route: "/api/auth/refresh",
        startedAtMs,
        status: 401,
        body: { error: "Account is temporarily locked. Refresh token invalid." },
      });
    }
  }

  const assignedWallet = await getUserWallet(auth.session.userId);
  if (!assignedWallet || ("expired" in assignedWallet && assignedWallet.expired)) {
    logWarn("Auth refresh wallet revoked or expired", { ...context, userId: auth.session.userId });
    const response = jsonWithRequestContext(request, {
      route: "/api/auth/refresh",
      startedAtMs,
      status: 401,
      body: { error: "Session wallet mapping has expired or been revoked." },
    });
    response.cookies.delete(AUTH_COOKIE_KEY);
    return response;
  }

  const token = createSessionToken({
    email: auth.session.email,
    role: auth.session.role,
    userId: auth.session.userId,
    publicKey: sessionWallet,
  });

  const response = jsonWithRequestContext(request, {
    route: "/api/auth/refresh",
    startedAtMs,
    status: 200,
    body: {
      ok: true,
      user: {
        email: auth.session.email,
        role: auth.session.role,
        userId: auth.session.userId,
      },
    },
    // The response rotates a session cookie, so it must never be cached.
    noStore: true,
  });

  setSessionCookie(response, rotated.token);

  logInfo("Auth refresh success", {
    ...context,
    userId: auth.session.userId,
    role: auth.session.role,
    generation: rotated.generation,
  });

  return response;
}
