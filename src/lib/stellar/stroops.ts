/**
 * Exact decimal arithmetic for XLM amounts (issue #178).
 *
 * Stellar amounts are integers of stroops: one XLM is exactly 10,000,000
 * stroops, and nothing finer exists. Representing them as JavaScript numbers
 * means representing decimal fractions in binary floating point, where `0.1`
 * and `0.2` are both approximations and `0.1 + 0.2` is `0.30000000000000004` —
 * strictly greater than `0.3`. A policy that compares a running total against a
 * cap in floating point therefore refuses payments that land exactly on the cap.
 *
 * Every amount that participates in a limit decision is converted to a `bigint`
 * count of stroops first, so the comparison is integer arithmetic and the drift
 * cannot occur.
 */

export const STROOPS_PER_XLM = 10_000_000n;
export const XLM_DECIMAL_PLACES = 7;

const TEN = 10n;

/** Why a value could not be read as an exact XLM amount. */
export type StroopParseErrorCode = "not_a_decimal" | "excess_precision" | "negative" | "not_finite";

export type StroopParseResult =
  { ok: true; stroops: bigint } | { ok: false; code: StroopParseErrorCode };

/** Optional sign, digits, optional fraction, optional exponent. */
const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u;

function pow10(exponent: number): bigint {
  return TEN ** BigInt(exponent);
}

/**
 * Reads a decimal string as an exact stroop count.
 *
 * The string is never routed through `Number`, so no precision is lost on the
 * way in. A value finer than one stroop is rejected as `excess_precision`
 * rather than silently rounded — rounding here would change the amount a user
 * authorized. Trailing zeros are not excess precision: `"1.50000000"` is
 * exactly `1.5`, which Stellar itself accepts.
 */
export function parseXlmToStroops(value: string): StroopParseResult {
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) {
    return { ok: false, code: "not_a_decimal" };
  }

  const [, sign, whole, fraction = "", exponent] = match;
  if (sign === "-") {
    return { ok: false, code: "negative" };
  }

  const mantissa = BigInt(whole + fraction);
  const exponentShift = exponent ? Number(exponent) : 0;
  if (!Number.isFinite(exponentShift)) {
    return { ok: false, code: "not_finite" };
  }

  // value === mantissa / 10 ** scale
  const scale = fraction.length - exponentShift;

  if (scale <= XLM_DECIMAL_PLACES) {
    return { ok: true, stroops: mantissa * pow10(XLM_DECIMAL_PLACES - scale) };
  }

  // Finer than a stroop unless the extra places are all zeros.
  const divisor = pow10(scale - XLM_DECIMAL_PLACES);
  if (mantissa % divisor !== 0n) {
    return { ok: false, code: "excess_precision" };
  }

  return { ok: true, stroops: mantissa / divisor };
}

/**
 * Reads a number as an exact stroop count.
 *
 * The number is converted through its shortest round-trip decimal form rather
 * than by scaling in floating point, so `0.1` yields exactly 1,000,000 stroops.
 * A double that does not land on a stroop — `0.30000000000000004`, the result
 * of `0.1 + 0.2` — is reported as `excess_precision` rather than accepted as an
 * amount nobody chose.
 */
export function parseXlmNumberToStroops(value: number): StroopParseResult {
  if (!Number.isFinite(value)) {
    return { ok: false, code: "not_finite" };
  }

  return parseXlmToStroops(value.toString());
}

/**
 * Converts a display amount to stroops with the exact decimal parser.
 * Numbers go through their shortest decimal form; strings are never scaled
 * in floating point. Values finer than one stroop are rejected.
 */
export function amountToStroops(value: number | string): StroopParseResult {
  return typeof value === "number" ? parseXlmNumberToStroops(value) : parseXlmToStroops(value);
}

/**
 * Converts a number to the nearest stroop, half away from zero.
 *
 * For *comparisons* — a cap, a running total — the question is which side of a
 * boundary a value falls on, and a stored limit that drifted a fraction of a
 * stroop should not decide that. Amounts a user authorizes are held to
 * `parseXlmNumberToStroops` instead, which refuses to round.
 */
export function toNearestStroops(value: number): bigint {
  if (!Number.isFinite(value)) {
    return 0n;
  }

  const exact = parseXlmNumberToStroops(value);
  if (exact.ok) {
    return exact.stroops;
  }

  const match = DECIMAL_PATTERN.exec(Math.abs(value).toString());
  if (!match) {
    return 0n;
  }

  const [, , whole, fraction = "", exponent] = match;
  const mantissa = BigInt(whole + fraction);
  const scale = fraction.length - (exponent ? Number(exponent) : 0);
  const divisor = pow10(scale - XLM_DECIMAL_PLACES);
  const quotient = mantissa / divisor;
  const remainder = mantissa % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;

  return value < 0 ? -rounded : rounded;
}

/** Renders a stroop count as a canonical 7-decimal XLM string. */
export function stroopsToXlmString(stroops: bigint): string {
  const negative = stroops < 0n;
  const magnitude = negative ? -stroops : stroops;
  const whole = magnitude / STROOPS_PER_XLM;
  const fraction = (magnitude % STROOPS_PER_XLM).toString().padStart(XLM_DECIMAL_PLACES, "0");

  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}
