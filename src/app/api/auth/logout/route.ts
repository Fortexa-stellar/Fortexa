import { NextRequest, NextResponse } from "next/server";

import { AUTH_COOKIE_KEY, verifySessionToken } from "@/lib/auth/session";
import { revokeSession as revokeSessionRevocation } from "@/lib/auth/session-revocation";
import { revokeSession as revokeSessionStore } from "@/lib/auth/session-store";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE_KEY)?.value;
  const session = token ? verifySessionToken(token, { allowStaleGeneration: true }) : null;

  if (session) {
    await revokeSessionRevocation(session);
    if (session.gen > 0) {
      revokeSessionStore({ userId: session.userId, sessionId: session.sid });
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_KEY, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
