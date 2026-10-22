import type { NextRequest } from "next/server";

import { recordRateLimitRejection } from "@/lib/observability/metrics";
import {
  clearSharedRateLimits,
  consumeSharedRateLimit,
  isSharedSecurityStateEnabled,
} from "@/lib/security/shared-security-state";

type BucketConfig = {
  key: string;
  limit: number;
  windowMs: number;
};

type BucketState = {
  count: number;
  resetAt: number;
};

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
};

const buckets = new Map<string, BucketState>();

function getClientIp(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }

  const realIp = request.headers.get("x-real-ip");
  return realIp?.trim() || "unknown";
}

export async function consumeRateLimit(
  request: NextRequest,
  config: BucketConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const ip = getClientIp(request);
  const bucketKey = `${config.key}:${ip}`;
  const useSharedState = isSharedSecurityStateEnabled();

  if (useSharedState) {
    // Consume the slot atomically in the shared store: a read-then-write
    // across an await lets two parallel requests both pass the last allowed
    // slot (issue #202).
    const { allowed, state } = await consumeSharedRateLimit(bucketKey, {
      limit: config.limit,
      windowMs: config.windowMs,
    });

    if (!allowed) {
      return {
        ok: false,
        limit: config.limit,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
        resetAt: state.resetAt,
      };
    }

    return {
      ok: true,
      limit: config.limit,
      remaining: Math.max(0, config.limit - state.count),
      retryAfterSeconds: 0,
      resetAt: state.resetAt,
    };
  }

  const current = buckets.get(bucketKey);

  if (!current || now >= current.resetAt) {
    const fresh: BucketState = {
      count: 1,
      resetAt: now + config.windowMs,
    };

    buckets.set(bucketKey, fresh);

    return {
      ok: true,
      limit: config.limit,
      remaining: Math.max(0, config.limit - 1),
      retryAfterSeconds: 0,
      resetAt: fresh.resetAt,
    };
  }

  if (current.count >= config.limit) {
    // Counted here (single choke point) so the ops dashboard and the metrics
    // scrape report the same rejection count as the 429s actually returned.
    recordRateLimitRejection();

    return {
      ok: false,
      limit: config.limit,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      resetAt: current.resetAt,
    };
  }

  current.count += 1;
  buckets.set(bucketKey, current);

  return {
    ok: true,
    limit: config.limit,
    remaining: Math.max(0, config.limit - current.count),
    retryAfterSeconds: 0,
    resetAt: current.resetAt,
  };
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.floor(result.resetAt / 1000)),
    "Retry-After": String(result.retryAfterSeconds),
  };
}

export async function resetRateLimitStore() {
  buckets.clear();
  if (isSharedSecurityStateEnabled()) {
    await clearSharedRateLimits();
  }
}
