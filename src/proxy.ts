import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { AUTH_COOKIE_KEY, verifySessionToken } from "@/lib/auth/session";
import { applySecurityHeaders } from "@/lib/security/headers";

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/console",
  "/settings",
  "/overview",
  "/app",
  "/wallet",
  "/policies",
  "/scenarios",
  "/activity",
  "/ops",
];

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

function hasValidSession(request: NextRequest) {
  const token = request.cookies.get(AUTH_COOKIE_KEY)?.value;
  if (!token) {
    return false;
  }
  return Boolean(verifySessionToken(token));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const authed = hasValidSession(request);

  if (pathname === "/login" && authed) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  if (isProtectedPath(pathname) && !authed) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const response = NextResponse.next();
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();

  // Share the exact same header writer as the auth/payment route handlers so
  // page and API responses never drift apart.
  return applySecurityHeaders(response, requestId);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api|icon.jpg).*)"],
};
