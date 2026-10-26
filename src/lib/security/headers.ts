export function buildSecurityHeaders(): Record<string, string> {
  const isDev = process.env.NODE_ENV === "development";

  const cspDirectives = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
  ];

  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": cspDirectives.join("; "),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

export type SecurityHeaderOptions = {
  /**
   * Mark the response as uncacheable. Required for responses that carry a
   * decision or set/clear a session cookie.
   */
  noStore?: boolean;
};

/**
 * The single source of truth for the security header set that the proxy and
 * every auth/payment route must send. `buildSecurityHeaders` holds the static
 * policy; this adds the per-response headers (request id, referrer policy,
 * cross-origin policies) and the optional cache directive.
 */
export function buildResponseSecurityHeaders(
  requestId: string,
  options: SecurityHeaderOptions = {}
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-request-id": requestId,
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...buildSecurityHeaders(),
  };

  if (options.noStore) {
    headers["Cache-Control"] = "no-store";
  }

  return headers;
}

/**
 * Shared header writer used by the proxy and route handlers. Applies the full
 * security header set to an existing response so success and error responses
 * cannot drift apart.
 */
export function applySecurityHeaders<T extends { headers: Headers }>(
  response: T,
  requestId: string,
  options: SecurityHeaderOptions = {}
): T {
  for (const [key, value] of Object.entries(buildResponseSecurityHeaders(requestId, options))) {
    response.headers.set(key, value);
  }

  return response;
}

/**
 * Convenience wrapper for route handlers that build their own responses: reads
 * (or mints) the request id and returns the header record the route should
 * merge into `NextResponse.json`.
 */
export function securityHeadersForRequest(
  request: { headers: Headers },
  options: SecurityHeaderOptions = {}
): Record<string, string> {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  return buildResponseSecurityHeaders(requestId, options);
}
