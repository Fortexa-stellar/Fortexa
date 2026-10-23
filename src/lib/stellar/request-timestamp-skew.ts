/**
 * Clock-skew validation for client-supplied timestamps on signed payment
 * requests.
 *
 * A payment request that carries a client-supplied timestamp should be
 * rejected if that timestamp is too old (the signed payload may have been
 * captured and replayed later) or implausibly far in the future (the
 * client's clock is wrong, or the timestamp is being used to smuggle a
 * request past other staleness checks that key off it). This module is the
 * shared, configurable primitive for that check -- see
 * {@link validateRequestTimestamp}.
 */

/** Default maximum age of a request timestamp, in seconds. */
const DEFAULT_MAX_PAST_SKEW_SECONDS = 60;
/** Default maximum look-ahead of a request timestamp, in seconds. */
const DEFAULT_MAX_FUTURE_SKEW_SECONDS = 30;

export interface RequestTimestampSkewConfig {
  /** How far in the past a timestamp may be and still be accepted. */
  maxPastSkewSeconds: number;
  /** How far in the future a timestamp may be and still be accepted. */
  maxFutureSkewSeconds: number;
}

function readSkewSecondsEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Reads the configured clock-skew window from environment variables,
 * falling back to sane defaults when a variable is unset, non-numeric, or
 * not a positive number:
 *
 * - `FORTEXA_REQUEST_TIMESTAMP_MAX_PAST_SKEW_SECONDS` (default: 60)
 * - `FORTEXA_REQUEST_TIMESTAMP_MAX_FUTURE_SKEW_SECONDS` (default: 30)
 */
export function getRequestTimestampSkewConfig(): RequestTimestampSkewConfig {
  return {
    maxPastSkewSeconds: readSkewSecondsEnv(
      "FORTEXA_REQUEST_TIMESTAMP_MAX_PAST_SKEW_SECONDS",
      DEFAULT_MAX_PAST_SKEW_SECONDS
    ),
    maxFutureSkewSeconds: readSkewSecondsEnv(
      "FORTEXA_REQUEST_TIMESTAMP_MAX_FUTURE_SKEW_SECONDS",
      DEFAULT_MAX_FUTURE_SKEW_SECONDS
    ),
  };
}

export type RequestTimestampValidationResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * `stale`: older than `maxPastSkewSeconds`.
       * `future`: further ahead than `maxFutureSkewSeconds`.
       * `invalid`: not a finite epoch-millisecond number at all.
       */
      code: "stale" | "future" | "invalid";
      /** Magnitude of how far outside the window the timestamp fell, in ms. */
      skewMs: number;
      /** The allowed skew (in ms) in the direction that was violated. */
      maxAllowedMs: number;
    };

/**
 * Validate that `timestampMs` (an epoch-millisecond timestamp taken from a
 * signed request) falls within the acceptable clock-skew window around
 * `nowMs` (defaults to `Date.now()`).
 *
 * Boundary semantics: **both edges are inclusive**. A timestamp exactly
 * `maxPastSkewSeconds` in the past, or exactly `maxFutureSkewSeconds` in
 * the future, is valid -- only a timestamp *strictly* outside either bound
 * is rejected. This matches the conventional "the edge of the window still
 * counts as inside it" reading of a skew tolerance, and is pinned down
 * explicitly by the boundary tests in this module's test file so it can't
 * drift by accident.
 *
 * @param timestampMs - Epoch-millisecond timestamp to validate.
 * @param options - Overrides for the configured skew window and/or the
 *   reference "now" (the latter primarily for deterministic tests).
 *   Unset fields fall back to {@link getRequestTimestampSkewConfig}.
 */
export function validateRequestTimestamp(
  timestampMs: number,
  options: Partial<RequestTimestampSkewConfig> & { nowMs?: number } = {}
): RequestTimestampValidationResult {
  if (!Number.isFinite(timestampMs)) {
    return { ok: false, code: "invalid", skewMs: Number.NaN, maxAllowedMs: 0 };
  }

  const config = getRequestTimestampSkewConfig();
  const maxPastSkewSeconds = options.maxPastSkewSeconds ?? config.maxPastSkewSeconds;
  const maxFutureSkewSeconds = options.maxFutureSkewSeconds ?? config.maxFutureSkewSeconds;
  const nowMs = options.nowMs ?? Date.now();

  const skewMs = timestampMs - nowMs;

  if (skewMs < 0) {
    const maxAllowedMs = maxPastSkewSeconds * 1000;
    const ageMs = -skewMs;
    if (ageMs > maxAllowedMs) {
      return { ok: false, code: "stale", skewMs: ageMs, maxAllowedMs };
    }
    return { ok: true };
  }

  const maxAllowedMs = maxFutureSkewSeconds * 1000;
  if (skewMs > maxAllowedMs) {
    return { ok: false, code: "future", skewMs, maxAllowedMs };
  }
  return { ok: true };
}
