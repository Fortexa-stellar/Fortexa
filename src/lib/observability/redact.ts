const SENSITIVE_KEYS = new Set([
  "signature",
  "signed_xdr",
  "signedxdr",
  "xdr",
  "authorization",
  "cookie",
  "fortexa_session",
  "groq_api_key",
  "api_key",
  "apikey",
  "secret",
  "token",
  "password",
  "challenge",
  "memo",
]);

// Stellar account addresses (G...) and contract addresses (C...) must not
// appear in log lines or metric labels (#205: destination addresses).
const STELLAR_ADDRESS_PATTERN = /\b[GC][A-Z2-7]{55}\b/g;

// Base64-encoded signed transaction envelopes. Signed XDR is a long
// unpadded/base64url-ish blob; treat any 100+ char base64 run as sensitive
// rather than trying to parse envelopes. No trailing \\b so trailing '='
// padding is consumed instead of leaking.
const XDR_BLOB_PATTERN = /\b[A-Za-z0-9+/=_-]{100,}/g;

// key=value / key:"value" style secret assignments that leak into free-text
// error messages and serialized payloads.
const SECRET_ASSIGNMENT_PATTERNS: Array<[RegExp, string]> = [
  [
    // #205: memo= values carry free-text payment context.
    /\b(memo)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
    "$1=[REDACTED]",
  ],
  [
    /\b(api[_-]?key|apikey|auth[_-]?token|access[_-]?token|password|passwd|pwd|bearer)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
    "$1=[REDACTED]",
  ],
  [/\b(secret|token|signature)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, "$1=[REDACTED]"],
  [
    /"(api[_-]?key|apikey|secret|token|signature|signed[_-]?xdr|xdr|password)"\s*:\s*"[^"]*"/gi,
    '"$1":"[REDACTED]"',
  ],
  [/Authorization:\s*(Bearer\s+)?[^,;"']+/gi, "Authorization: [REDACTED]"],
];

const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_ASSIGNMENT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  result = result.replace(XDR_BLOB_PATTERN, REDACTED);
  result = result.replace(STELLAR_ADDRESS_PATTERN, REDACTED);
  return result;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

const METRIC_TEXT_SENSITIVE_KEYS = new Set([...SENSITIVE_KEYS, "destination", "memo"]);

const SENSITIVE_PAIR_PATTERN = new RegExp(
  `\\b(${[...METRIC_TEXT_SENSITIVE_KEYS].join("|")})(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;]+)`,
  "gi"
);

const WALLET_PATTERN = /G[A-Z2-7]{55}/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

export function redactMetricText(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  return text
    .replace(/\r\n|\n|\r/g, " ")
    .replace(
      SENSITIVE_PAIR_PATTERN,
      (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`
    )
    .replace(WALLET_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]");
}

export function redactSensitiveFields<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields) as unknown as T;
  }

  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        redacted[key] = REDACTED;
      } else {
        redacted[key] = redactSensitiveFields(val);
      }
    }
    return redacted as T;
  }

  return value;
}
