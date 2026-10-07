import type { ZodError } from "zod";

import type { LogContext } from "@/lib/observability/logger";
import { logWarn } from "@/lib/observability/logger";
import { redactSensitiveFields } from "@/lib/observability/redact";

export const SENSITIVE_FIELD_KEYS = new Set([
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "fortexa_session",
  "groq_api_key",
  "password",
  "secret",
  "signature",
  "signed_xdr",
  "signedxdr",
  "token",
  "xdr",
]);

const PUBLIC_SENSITIVE_FIELD_MESSAGE = "Invalid value.";

// Memo values carry free-text user content; never log them (issue #205).
SENSITIVE_FIELD_KEYS.add("memo");

function fieldPathHasSensitiveKey(fieldPath: string): boolean {
  return fieldPath.split(".").some((segment) => SENSITIVE_FIELD_KEYS.has(segment.toLowerCase()));
}

export type PublicValidationDetails = {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
};

export function toPublicValidationDetails(error: ZodError): PublicValidationDetails {
  const flattened = error.flatten();
  const fieldErrors: Record<string, string[]> = {};

  for (const [field, messages] of Object.entries(flattened.fieldErrors) as Array<
    [string, string[] | undefined]
  >) {
    if (fieldPathHasSensitiveKey(field)) {
      fieldErrors[field] = [PUBLIC_SENSITIVE_FIELD_MESSAGE];
    } else {
      fieldErrors[field] = (messages as string[]) ?? [];
    }
  }

  return {
    formErrors: flattened.formErrors,
    fieldErrors,
  };
}

export const VALIDATION_ERROR_CODES = {
  MISSING_FIELD: "MISSING_FIELD",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_ASSET: "INVALID_ASSET",
  INVALID_MEMO: "INVALID_MEMO",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
} as const;

export type ValidationErrorCode =
  (typeof VALIDATION_ERROR_CODES)[keyof typeof VALIDATION_ERROR_CODES];

export const MISSING_FIELD = VALIDATION_ERROR_CODES.MISSING_FIELD;
export const INVALID_AMOUNT = VALIDATION_ERROR_CODES.INVALID_AMOUNT;
export const INVALID_ASSET = VALIDATION_ERROR_CODES.INVALID_ASSET;
export const INVALID_MEMO = VALIDATION_ERROR_CODES.INVALID_MEMO;
export const INVALID_PAYLOAD = VALIDATION_ERROR_CODES.INVALID_PAYLOAD;

export function categorizeValidationIssue(issue: {
  code?: string;
  path: (string | number)[];
  message?: string;
  received?: string;
}): ValidationErrorCode {
  const pathSegments = issue.path.map((p) => String(p).toLowerCase());
  const lastSegment = pathSegments[pathSegments.length - 1] ?? "";
  const fullPath = pathSegments.join(".");
  const message = (issue.message ?? "").toLowerCase();

  const isMissing =
    (issue.code === "invalid_type" &&
      (issue.received === "undefined" || message.includes("undefined"))) ||
    message.includes("required") ||
    message.includes("must be provided") ||
    message.includes("received undefined");

  if (isMissing) {
    return VALIDATION_ERROR_CODES.MISSING_FIELD;
  }

  if (
    lastSegment.includes("amount") ||
    lastSegment.includes("capxlm") ||
    lastSegment.includes("capstroops") ||
    fullPath.includes("amount") ||
    fullPath.includes("capxlm") ||
    fullPath.includes("capstroops")
  ) {
    return VALIDATION_ERROR_CODES.INVALID_AMOUNT;
  }

  if (lastSegment === "asset" || fullPath.endsWith(".asset")) {
    return VALIDATION_ERROR_CODES.INVALID_ASSET;
  }

  if (lastSegment === "memo" || fullPath.endsWith(".memo")) {
    return VALIDATION_ERROR_CODES.INVALID_MEMO;
  }

  return VALIDATION_ERROR_CODES.INVALID_PAYLOAD;
}

export function getValidationErrorCode(error: ZodError): ValidationErrorCode {
  const codes = error.issues.map(categorizeValidationIssue);

  const specific = codes.find(
    (c) =>
      c === VALIDATION_ERROR_CODES.INVALID_AMOUNT ||
      c === VALIDATION_ERROR_CODES.INVALID_ASSET ||
      c === VALIDATION_ERROR_CODES.INVALID_MEMO,
  );
  if (specific) {
    return specific;
  }

  const missing = codes.find((c) => c === VALIDATION_ERROR_CODES.MISSING_FIELD);
  if (missing) {
    return missing;
  }

  return codes[0] ?? VALIDATION_ERROR_CODES.INVALID_PAYLOAD;
}

export type ValidationErrorResponse = {
  error: string;
  code: ValidationErrorCode;
  details: PublicValidationDetails;
};

export function formatValidationErrorResponse(
  error: ZodError,
  fallbackMessage: string = "Validation failed.",
): ValidationErrorResponse {
  return {
    error: fallbackMessage,
    code: getValidationErrorCode(error),
    details: toPublicValidationDetails(error),
  };
}

const HORIZON_RESULT_CODE_PATTERN = /\btx_[a-z0-9_]+\b|\bop_[a-z0-9_]+\b/gi;

export function logValidationFailure(
  message: string,
  context: LogContext,
  error: ZodError,
  rawBody?: unknown,
): void {
  logWarn(
    message,
    redactSensitiveFields({
      ...context,
      validation: error.flatten(),
      body: rawBody,
    }) as unknown as LogContext,
  );
}
