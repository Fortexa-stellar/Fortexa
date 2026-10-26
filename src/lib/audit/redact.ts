export type RedactionReason =
  | "session"
  | "token"
  | "signed_xdr"
  | "sensitive_field";

export type RedactedValue = { $redacted: RedactionReason };

const DEFAULT_REDACTED_PLACEHOLDER: RedactedValue = {
  $redacted: "sensitive_field",
};

type RedactionConfig = {
  /** Explicit sensitive keys (case-insensitive, compared to the key only). */
  sensitiveKeys?: string[];
  /** Additional regexes to match on key names (case-insensitive). */
  sensitiveKeyPatterns?: RegExp[];
  /** Additional patterns to match on string values. */
  sensitiveValuePatterns?: RegExp[];
  /** Max depth to traverse to avoid pathological inputs. */
  maxDepth?: number;
};

const ENV_SENSITIVE_KEYS: string[] = (
  (globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.FORTEXA_AUDIT_EXPORT_SENSITIVE_KEYS ?? ""
)
  .split(",")
  .map((s: string) => s.trim())
  .filter((s: string) => Boolean(s));

const DEFAULT_CONFIG: RedactionConfig = {
  sensitiveKeys: [
    // session-ish
    "session",
    "sessionKey",
    "session_id",
    "sessionId",
    "wallet_session",
    "authSession",

    // tokens / auth
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "bearer",
    "bearerToken",
    "authorization",
    "auth",
    "jwt",

    // signed tx material
    "signedXDR",
    "signed_xdr",
    "xdr",
    "signed",
    "signature",
  ],
  sensitiveKeyPatterns: [
    // broad session/token indicators
    /session/i,
    /bearer/i,
    /access[_-]?token/i,
    /refresh[_-]?token/i,
    /authorization/i,
    /auth[_-]?token/i,
    // signed transaction markers
    /signed[_-]?xdr/i,
    /signed[_-]?tx/i,
    /xdr[_-]?signed/i,
    /submit[_-]?signed/i,
    // any raw XDR payload keys
    /^xdr$/i,
  ],
  sensitiveValuePatterns: [
    // XDR strings often look like base64-ish blocks with length and symbols.
    // Also redact explicit `XDR:` prefixes.
    /^XDR:\s*/i,
    // A loose heuristic: contains lots of base64-ish chars.
    /[A-Za-z0-9+/]{20,}={0,2}/,
    // If value indicates it is signed.
    /signed[_\s-]?xdr/i,
    /signed[_\s-]?tx/i,
    // JWT-ish
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  ],
  maxDepth: 25,
};

function normalizeKey(key: string) {
  return key.trim().toLowerCase();
}

function placeholderForReason(reason: RedactionReason): RedactedValue {
  return { $redacted: reason };
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeSignedXdrValue(value: string): boolean {
  // Fast heuristics only; goal is never to leak secrets, not to be perfect.
  if (/^XDR:\s*/i.test(value)) return true;
  if (/signed[_\s-]?xdr/i.test(value)) return true;
  if (/signed[_\s-]?tx/i.test(value)) return true;

  // Heuristic: long-ish base64-ish blocks.
  if (value.length >= 50 && /[A-Za-z0-9+/]{20,}={0,2}/.test(value)) return true;

  return false;
}

function classifyKeyAndValue(
  key: string,
  value: unknown,
): RedactionReason | null {
  const nk = normalizeKey(key);

  const sensitiveKeys = [
    ...(DEFAULT_CONFIG.sensitiveKeys ?? []),
    ...ENV_SENSITIVE_KEYS,
  ].map(normalizeKey);

  if (sensitiveKeys.includes(nk)) {
    if (/(session)/i.test(key)) return "session";
    if (/(token|bearer|authorization|jwt|auth)/i.test(key)) return "token";
    if (/(signed|xdr|signature)/i.test(key)) return "signed_xdr";
    return "sensitive_field";
  }

  for (const re of DEFAULT_CONFIG.sensitiveKeyPatterns ?? []) {
    if (re.test(key)) {
      if (/session/i.test(key)) return "session";
      if (/bearer|token|authorization|jwt|auth/i.test(key)) return "token";
      if (/signed|xdr|signature/i.test(key)) return "signed_xdr";
      return "sensitive_field";
    }
  }

  if (typeof value === "string") {
    const s = value;

    // Value-based redaction
    for (const vre of DEFAULT_CONFIG.sensitiveValuePatterns ?? []) {
      if (vre.test(s)) {
        if (/signed[_\s-]?xdr/i.test(s) || looksLikeSignedXdrValue(s)) {
          return "signed_xdr";
        }
        if (/jwt|bearer|token/i.test(s)) return "token";
      }
    }

    if (looksLikeSignedXdrValue(s)) {
      return "signed_xdr";
    }
  }

  // Sometimes signed material sits under generic keys.
  if (typeof value === "string" && looksLikeSignedXdrValue(value)) {
    return "signed_xdr";
  }

  return null;
}

/**
 * Redacts sensitive fields from an arbitrary JSON-like payload.
 *
 * Safety goals:
 * - Never leak session keys, bearer/auth tokens, or signed XDR material.
 * - Preserve non-sensitive evidence.
 * - Keep output shape (keys/arrays) for debuggability.
 */
export function redactAuditExportPayload<T>(
  input: T,
  config?: RedactionConfig,
): T {
  const merged: RedactionConfig = {
    ...DEFAULT_CONFIG,
    ...(config ?? {}),
    sensitiveKeys: [
      ...(DEFAULT_CONFIG.sensitiveKeys ?? []),
      ...(config?.sensitiveKeys ?? []),
      ...ENV_SENSITIVE_KEYS,
    ],
    sensitiveKeyPatterns: [
      ...(DEFAULT_CONFIG.sensitiveKeyPatterns ?? []),
      ...(config?.sensitiveKeyPatterns ?? []),
    ],
    sensitiveValuePatterns: [
      ...(DEFAULT_CONFIG.sensitiveValuePatterns ?? []),
      ...(config?.sensitiveValuePatterns ?? []),
    ],
    maxDepth: config?.maxDepth ?? DEFAULT_CONFIG.maxDepth,
  };

  const seen = new WeakSet<object>();

  function walk(value: unknown, depth: number): unknown {
    if (depth > (merged.maxDepth ?? 25)) return value;

    if (typeof value === "string") {
      // Value-only classification for signed xdr
      if (looksLikeSignedXdrValue(value)) {
        return placeholderForReason("signed_xdr");
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((v) => walk(v, depth + 1));
    }

    if (isObjectLike(value)) {
      if (seen.has(value)) return value;
      seen.add(value);

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        // Preserve Horizon result codes etc. by explicitly not redacting common safe keys.
        const safeKeyAllowlist = new Set([
          "horizonResultCode",
          "result",
          "resultCode",
          "code",
          "status",
          "reason",
          "entryHash",
          "previousHash",
          "firstEntryHash",
          "lastEntryHash",
          "chainBoundary",
          "chainBoundariesByUser",
          "timestamp",
          "decision",
          "triggeredPolicies",
          "riskFindings",
        ]);

        if (safeKeyAllowlist.has(k)) {
          out[k] = walk(v, depth + 1);
          continue;
        }

        const reason = classifyKeyAndValue(k, v);
        out[k] = reason ? placeholderForReason(reason) : walk(v, depth + 1);
      }

      return out;
    }

    return value;
  }

  return walk(input, 0) as T;
}

/**
 * Convenience wrapper for redacting a list of audit entries.
 */
export function redactAuditExportEntries<T>(entries: T[]): T[] {
  return entries.map((e) => redactAuditExportPayload(e));
}

export function redactAuditExportEntriesByUser<T>(
  entriesByUser: Record<string, T[]>,
): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const [userId, entries] of Object.entries(entriesByUser)) {
    out[userId] = redactAuditExportEntries(entries);
  }
  return out;
}

export const REDACTION_PLACEHOLDER = DEFAULT_REDACTED_PLACEHOLDER;
