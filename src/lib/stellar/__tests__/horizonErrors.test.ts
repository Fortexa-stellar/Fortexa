import { describe, expect, it } from "vitest";
import { normalizeHorizonError, HorizonErrorCategory } from "@/lib/utils/horizonErrors";

describe("normalizeHorizonError", () => {
  it("maps transaction codes correctly", () => {
    expect(normalizeHorizonError("tx_bad_seq")).toBe(HorizonErrorCategory.BAD_SEQUENCE);
    expect(normalizeHorizonError("tx_insufficient_balance")).toBe(
      HorizonErrorCategory.INSUFFICIENT_BALANCE
    );
    expect(normalizeHorizonError("tx_malformed")).toBe(HorizonErrorCategory.MALFORMED_XDR);
    expect(normalizeHorizonError("tx_failed")).toBe(HorizonErrorCategory.TRANSACTION_FAILED);
    expect(normalizeHorizonError("tx_timeout")).toBe(
      HorizonErrorCategory.TIMEOUT_OR_NETWORK_FAILURE
    );
  });

  it("maps operation codes correctly", () => {
    expect(normalizeHorizonError("op_underfunded")).toBe(HorizonErrorCategory.INSUFFICIENT_BALANCE);
    expect(normalizeHorizonError("op_insufficient_balance")).toBe(
      HorizonErrorCategory.INSUFFICIENT_BALANCE
    );
    expect(normalizeHorizonError("op_no_destination")).toBe(
      HorizonErrorCategory.TRANSACTION_FAILED
    );
    expect(normalizeHorizonError("op_line_full")).toBe(HorizonErrorCategory.TRANSACTION_FAILED);
  });

  it("returns UNKNOWN_ERROR for unmapped or undefined codes", () => {
    expect(normalizeHorizonError("some_unknown_code")).toBe(HorizonErrorCategory.UNKNOWN_ERROR);
    expect(normalizeHorizonError(undefined)).toBe(HorizonErrorCategory.UNKNOWN_ERROR);
  });
});
