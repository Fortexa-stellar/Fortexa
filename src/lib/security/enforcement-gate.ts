import type { NextRequest } from "next/server";

import { BlocklistUrlError, fetchBlocklist } from "@/lib/security/blocklist";
import {
  consumeRateLimit,
  rateLimitHeaders,
  type RateLimitResult,
} from "@/lib/security/rate-limit";

/**
 * Stable error codes returned by the shared enforcement gate (issue #202).
 *
 * Clients and operators can branch on these instead of parsing free-text
 * error messages: `BLOCKLISTED` for a destination/feed verdict, and
 * `RATE_LIMITED` for an exhausted caller budget. The HTTP status still
 * distinguishes them (403 vs 429), but the code is the stable contract.
 */
export type EnforcementGateErrorCode = "BLOCKLISTED" | "RATE_LIMITED";

export type EnforcementGateAllowed = {
  ok: true;
  /** Rate-limit state for the standard X-RateLimit-* response headers. */
  rate: RateLimitResult;
};

export type EnforcementGateDenied = {
  ok: false;
  code: EnforcementGateErrorCode;
  /** 403 for a blocklist verdict, 429 for an exhausted rate budget. */
  status: 403 | 429;
  error: string;
  rate: RateLimitResult | null;
};

export type EnforcementGateResult =
  | EnforcementGateAllowed
  | EnforcementGateDenied;

/**
 * Destinations that are payment-relevant for blocklist enforcement. The
 * feed itself is domain-oriented, so the destination's domain portion (the
 * part after the first `/`, e.g. `api.gateway.com` in
 * `https://api.gateway.com/pay`) is what gets checked. Federation-style
 * Stellar addresses (`name*domain`) check the domain after `*`.
 */
export function extractDestinationDomain(destination: string): string {
  const trimmed = destination.trim().toLowerCase();

  // SEP-2 federated address: user*domain.tld
  const federated = trimmed.includes("*") ? trimmed.split("*").pop() : trimmed;

  // URL-ish target: scheme://host/... -> host
  const withoutScheme = (federated ?? trimmed).replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = withoutScheme.split("/")[0] ?? "";

  // Strip a :port suffix if present
  return host.split(":")[0] ?? "";
}

/**
 * Checks the destination domain against the threat-intel blocklist feed.
 *
 * The feed has a 5-minute in-memory cache and refresh failures are already
 * tolerated by the analyzer path; here a feed failure also degrades open
 * (returns `blocked: false`) rather than taking payment flows down. The
 * verdict itself is a pure set lookup, so it is safe to run before the
 * rate-limit consumption below.
 */
async function checkDestinationAgainstBlocklist(
  destinationDomain: string,
): Promise<{ blocked: boolean }> {
  if (!destinationDomain) {
    return { blocked: false };
  }

  try {
    const blocklist = await fetchBlocklist();
    return { blocked: blocklist.includes(destinationDomain) };
  } catch (err) {
    if (err instanceof BlocklistUrlError) {
      throw err;
    }
    // Feed unavailable: degrade open (the analyzer records the degraded
    // state for the decision path; submit/build still enforce rate limits).
    return { blocked: false };
  }
}

/**
 * Shared enforcement gate for the money-movement routes (issue #202).
 *
 * One gate, one order of checks, for `/api/decision`,
 * `/api/stellar/build-payment`, and `/api/stellar/submit-signed`:
 *
 * 1. The caller's rate budget is consumed atomically (shared Redis/file
 *    state when configured, so two parallel requests cannot both pass the
 *    last allowed slot — see `consumeRateLimit`).
 * 2. The destination is checked against the blocklist feed before any side
 *    effect (policy evaluation, XDR construction, Horizon submission).
 *
 * A destination blocked on one route is blocked on all three, and the
 * response always carries the stable `code` plus rate-limit headers.
 */
export async function enforceRequestGate(
  request: NextRequest,
  config: {
    /** Route-scoped limiter key, e.g. `decision`. */
    rateLimitKey: string;
    /** Requests allowed per window for this caller. */
    limit: number;
    windowMs: number;
    /** Destination to check against the blocklist, when the request carries one. */
    destination?: string;
    /**
     * Action domain to check as well (decision route). The payment target
     * and the domain it is reached through are both blocklist-relevant.
     */
    actionDomain?: string;
  },
): Promise<EnforcementGateResult> {
  const rate = await consumeRateLimit(request, {
    key: config.rateLimitKey,
    limit: config.limit,
    windowMs: config.windowMs,
  });

  if (!rate.ok) {
    return {
      ok: false,
      code: "RATE_LIMITED",
      status: 429,
      error: `Rate limit exceeded for ${config.rateLimitKey}.`,
      rate,
    };
  }

  const candidates = [config.destination, config.actionDomain]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(extractDestinationDomain)
    .filter((domain) => domain.length > 0);

  for (const candidate of candidates) {
    const { blocked } = await checkDestinationAgainstBlocklist(candidate);
    if (blocked) {
      return {
        ok: false,
        code: "BLOCKLISTED",
        status: 403,
        error:
          "Destination is on the configured threat-intel blocklist. Payment execution is denied.",
        rate,
      };
    }
  }

  return { ok: true, rate };
}

/**
 * Standard error response headers for a denied request. Rate-limit headers
 * are always present; a 429 additionally carries Retry-After semantics via
 * the same helper used elsewhere in the codebase.
 */
export function gateErrorHeaders(result: EnforcementGateDenied): Record<string, string> {
  if (!result.rate) {
    return {};
  }
  return rateLimitHeaders(result.rate);
}
