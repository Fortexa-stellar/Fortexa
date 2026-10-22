/**
 * List of fields that should be redacted in audit rows
 */
const SECRET_FIELDS = new Set([
  "secret",
  "privateKey",
  "apiKey",
  "password",
  "token",
  "authorization",
  "accessToken",
  "refreshToken",
  "seed",
  "mnemonic",
]);

/**
 * Recursively redacts secret fields from an object
 * @param obj The object to redact
 * @returns A new object with secrets replaced by '[REDACTED]'
 */
function redactObject(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(redactObject);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactObject(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Redacts secret fields from an audit row
 * @param row The audit row to redact
 * @returns A new row with secrets redacted
 */
export function redactSecrets<T extends { details: unknown }>(row: T): T {
  return {
    ...row,
    details: redactObject(row.details),
  };
}
