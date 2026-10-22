import { describe, expect, it } from "vitest";

import {
  applyValidateResponse,
  buildValidationDisplayErrors,
  canActivateDraft,
  draftIsBlockedByFailedValidation,
  fieldErrorsToDisplayList,
  serializePolicyDraft,
  INITIAL_POLICY_VALIDATION_GATE,
} from "@/lib/policy/activation";
import type { PolicyConfig } from "@/lib/types/domain";

const POLICY: PolicyConfig = {
  allowedDomains: ["api.example.com"],
  blockedDomains: ["malicious.com"],
  allowedTools: ["research-pro"],
  blockedTools: ["shadow-shell"],
  perTxCapXLM: 150,
  dailyCapXLM: 300,
  maxToolCallsPerDay: 10,
  riskThreshold: 80,
  allowedHours: { start: 6, end: 23 },
};

describe("policy activation gate", () => {
  it("blocks activation before any validation ran", () => {
    const draftKey = serializePolicyDraft(POLICY);

    expect(canActivateDraft(INITIAL_POLICY_VALIDATION_GATE, draftKey)).toBe(false);
    expect(draftIsBlockedByFailedValidation(INITIAL_POLICY_VALIDATION_GATE, draftKey)).toBe(false);
  });

  it("unlocks activation only for the exact draft the validate route accepted", () => {
    const draftKey = serializePolicyDraft(POLICY);
    const gate = applyValidateResponse(draftKey, true, { valid: true, data: POLICY });

    expect(gate.status).toBe("valid");
    expect(canActivateDraft(gate, draftKey)).toBe(true);

    // Editing the draft changes the key, so the old pass no longer unlocks it.
    const editedKey = serializePolicyDraft({ ...POLICY, perTxCapXLM: 200 });
    expect(canActivateDraft(gate, editedKey)).toBe(false);
  });

  it("blocks activation and keeps API errors verbatim when validation fails", () => {
    const draftKey = serializePolicyDraft(POLICY);
    const apiMessage = "Too small: expected number to be >0";
    const gate = applyValidateResponse(draftKey, false, {
      valid: false,
      errors: [`perTxCapXLM: ${apiMessage}`],
      fieldErrors: { perTxCapXLM: [apiMessage] },
    });

    expect(gate.status).toBe("invalid");
    expect(gate.errors).toEqual([`perTxCapXLM: ${apiMessage}`]);
    expect(gate.fieldErrors).toEqual({ perTxCapXLM: [apiMessage] });
    expect(canActivateDraft(gate, draftKey)).toBe(false);
    expect(draftIsBlockedByFailedValidation(gate, draftKey)).toBe(true);

    // Display lines come from the API's field errors, unmodified.
    expect(buildValidationDisplayErrors(gate)).toEqual([`perTxCapXLM: ${apiMessage}`]);
  });

  it("falls back to the API error strings when no field map is returned", () => {
    const draftKey = serializePolicyDraft(POLICY);
    const duplicateMessage = 'Duplicate rule identifier "dup.example.com" found in allowedDomains.';
    const gate = applyValidateResponse(draftKey, false, {
      valid: false,
      errors: [duplicateMessage],
    });

    expect(gate.errors).toEqual([duplicateMessage]);
    expect(buildValidationDisplayErrors(gate)).toEqual([duplicateMessage]);
  });

  it("fails closed on network errors and non-2xx responses without a body", () => {
    const draftKey = serializePolicyDraft(POLICY);

    const networkFailure = applyValidateResponse(draftKey, false, undefined);
    expect(networkFailure.status).toBe("invalid");
    expect(networkFailure.errors.length).toBeGreaterThan(0);
    expect(canActivateDraft(networkFailure, draftKey)).toBe(false);

    const okWithoutValidFlag = applyValidateResponse(draftKey, true, { valid: false });
    expect(okWithoutValidFlag.status).toBe("invalid");
  });

  it("re-enables a retry once the draft changes after a failure", () => {
    const draftKey = serializePolicyDraft(POLICY);
    const gate = applyValidateResponse(draftKey, false, { valid: false, errors: ["bad"] });

    const editedKey = serializePolicyDraft({ ...POLICY, riskThreshold: 90 });
    expect(draftIsBlockedByFailedValidation(gate, editedKey)).toBe(false);
    expect(canActivateDraft(gate, editedKey)).toBe(false);
  });

  it("flattens field errors to path: message lines in API order", () => {
    expect(
      fieldErrorsToDisplayList({
        perTxCapXLM: ["Too small"],
        allowedDomains: ["Too small", "Invalid input"],
      })
    ).toEqual([
      "perTxCapXLM: Too small",
      "allowedDomains: Too small",
      "allowedDomains: Invalid input",
    ]);
  });
});
