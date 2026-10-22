/**
 * Activation gate shared by the policy editor and the API routes.
 *
 * The editor may only POST to /api/policy (i.e. activate a document) after
 * POST /api/policy/validate has accepted that exact document. The gate binds
 * a validation result to the serialized draft it was computed for, so any
 * edit to the draft invalidates a previous pass and re-requires validation.
 *
 * API error strings are carried through untouched: this module never
 * rewrites, reworded, or re-formats a message the server returned.
 */

export type ActivationGateStatus = "idle" | "validating" | "valid" | "invalid";

export type PolicyFieldErrors = Record<string, string[]>;

export type PolicyValidationGate = {
  status: ActivationGateStatus;
  /** Serialized draft the result applies to; null before first validation. */
  draftKey: string | null;
  /** Verbatim error strings from the API (`path: message` lines, etc.). */
  errors: string[];
  /** Verbatim per-field errors from the API, keyed by field path. */
  fieldErrors: PolicyFieldErrors;
};

/** Shape of a /api/policy/validate response body. */
export type ValidateRouteResponse = {
  valid?: boolean;
  errors?: string[];
  fieldErrors?: PolicyFieldErrors;
  code?: string;
  field?: string;
  duplicateValue?: string;
  error?: string;
};

export const INITIAL_POLICY_VALIDATION_GATE: PolicyValidationGate = {
  status: "idle",
  draftKey: null,
  errors: [],
  fieldErrors: {},
};

/** Serialize a draft document into the key the gate binds results to. */
export function serializePolicyDraft(policy: unknown): string {
  return JSON.stringify(policy);
}

/**
 * Activation is allowed only when the validate route accepted this exact
 * draft. A pass for a stale draft (or no pass at all) keeps the gate closed.
 */
export function canActivateDraft(gate: PolicyValidationGate, draftKey: string | null): boolean {
  return (
    draftKey !== null &&
    gate.status === "valid" &&
    gate.draftKey === draftKey &&
    gate.errors.length === 0
  );
}

/**
 * Activate must stay disabled while validation has failed for the current
 * draft. Editing the draft changes the key, which re-enables a retry.
 */
export function draftIsBlockedByFailedValidation(
  gate: PolicyValidationGate,
  draftKey: string | null
): boolean {
  return draftKey !== null && gate.status === "invalid" && gate.draftKey === draftKey;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFieldErrorMap(value: unknown): value is PolicyFieldErrors {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(isStringArray);
}

/**
 * Fold a /api/policy/validate response into a gate update for `draftKey`.
 * A non-2xx response, `valid !== true`, or an unparsable body all count as
 * a failure — validation must fail closed.
 */
export function applyValidateResponse(
  draftKey: string | null,
  responseOk: boolean,
  payload: unknown
): PolicyValidationGate {
  const body = (payload ?? {}) as ValidateRouteResponse;
  const fieldErrors = isFieldErrorMap(body.fieldErrors) ? body.fieldErrors : {};
  const errors = isStringArray(body.errors) ? body.errors : [];

  if (!responseOk || body.valid !== true) {
    const fallback =
      errors.length > 0
        ? errors
        : typeof body.error === "string" && body.error.length > 0
          ? [body.error]
          : ["Validation failed."];

    return {
      status: "invalid",
      draftKey,
      errors: fallback,
      fieldErrors,
    };
  }

  return {
    status: "valid",
    draftKey,
    errors: [],
    fieldErrors: {},
  };
}

/** Flatten API field errors to `path: message` lines, preserving order. */
export function fieldErrorsToDisplayList(fieldErrors: PolicyFieldErrors): string[] {
  return Object.entries(fieldErrors).flatMap(([field, messages]) =>
    messages.map((message) => `${field}: ${message}`)
  );
}

/**
 * Display lines for a failed gate. Field errors come straight from the API;
 * the API's own error strings are the fallback when no field map exists.
 */
export function buildValidationDisplayErrors(gate: PolicyValidationGate): string[] {
  const fromFields = fieldErrorsToDisplayList(gate.fieldErrors);
  return fromFields.length > 0 ? fromFields : gate.errors;
}
