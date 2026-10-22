/**
 * Shared, bounded integer parser for small security-relevant env-driven
 * settings (lockout thresholds, TTLs, retry counts, ...). Anything that
 * isn't a finite integer inside [min, max] falls back to a safe default
 * instead of silently producing NaN, 0, a negative duration, or an
 * unbounded value that could be used to disable a protection.
 */
export interface BoundedIntegerOptions {
  /** Inclusive lower bound. Defaults to 1 (the common case: "at least one"). */
  min?: number;
  /** Inclusive upper bound. Defaults to Number.MAX_SAFE_INTEGER. */
  max?: number;
  /** Returned when the raw value is missing, non-numeric, or out of bounds. */
  fallback: number;
}

export function parseBoundedInteger(
  raw: string | undefined | null,
  options: BoundedIntegerOptions,
): number {
  const { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = options;

  if (raw === undefined || raw === null || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const floored = Math.floor(parsed);
  if (floored < min || floored > max) {
    return fallback;
  }

  return floored;
}
