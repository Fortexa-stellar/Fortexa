import { describe, expect, it } from "vitest";

import { redactMetricText, redactSensitiveFields } from "@/lib/observability/redact";

describe("redactSensitiveFields", () => {
  it("redacts a flat object with sensitive keys", () => {
    const input = { signature: "abc123", token: "xyz", name: "test" };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({ signature: "[REDACTED]", token: "[REDACTED]", name: "test" });
  });

  it("redacts keys case-insensitively", () => {
    const input = { Signature: "abc", SIGNATURE: "def", SiGnAtUrE: "ghi" };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({
      Signature: "[REDACTED]",
      SIGNATURE: "[REDACTED]",
      SiGnAtUrE: "[REDACTED]",
    });
  });

  it("redacts nested object values", () => {
    const input = {
      user: { token: "secret-token", name: "alice" },
      meta: { status: "ok" },
    };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({
      user: { token: "[REDACTED]", name: "alice" },
      meta: { status: "ok" },
    });
  });

  it("redacts values inside arrays", () => {
    const input = {
      logs: [
        { token: "abc", level: "info" },
        { token: "def", level: "warn" },
      ],
    };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({
      logs: [
        { token: "[REDACTED]", level: "info" },
        { token: "[REDACTED]", level: "warn" },
      ],
    });
  });

  it("redacts deeply nested structures", () => {
    const input = {
      level1: {
        level2: {
          level3: { secret: "deep-value", visible: true },
        },
      },
    };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({
      level1: {
        level2: {
          level3: { secret: "[REDACTED]", visible: true },
        },
      },
    });
  });

  it("redacts mixed arrays containing objects and primitives", () => {
    const input = {
      items: [{ token: "abc" }, "hello", 42, { secret: "shh", nested: [{ xdr: "signed-stuff" }] }],
    };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({
      items: [
        { token: "[REDACTED]" },
        "hello",
        42,
        { secret: "[REDACTED]", nested: [{ xdr: "[REDACTED]" }] },
      ],
    });
  });

  it("preserves non-sensitive values unchanged", () => {
    const input = {
      requestId: "req-123",
      route: "/api/test",
      method: "POST",
      userId: "user-1",
      statusCode: 200,
    };
    const output = redactSensitiveFields(input);
    expect(output).toEqual(input);
  });

  it("preserves boolean and null values", () => {
    const input = { active: true, deleted: false, data: null };
    const output = redactSensitiveFields(input);
    expect(output).toEqual(input);
  });

  it("redacts authorization header key", () => {
    const input = { authorization: "Bearer secret-token" };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({ authorization: "[REDACTED]" });
  });

  it("redacts cookie and fortexa_session keys", () => {
    const input = { cookie: "session=abc", fortexa_session: "xyz" };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({ cookie: "[REDACTED]", fortexa_session: "[REDACTED]" });
  });

  it("redacts GROQ_API_KEY regardless of casing", () => {
    const input = { GROQ_API_KEY: "sk-123", groq_api_key: "sk-456" };
    const output = redactSensitiveFields(input);
    expect(output).toEqual({ GROQ_API_KEY: "[REDACTED]", groq_api_key: "[REDACTED]" });
  });

  it("handles empty objects and arrays", () => {
    expect(redactSensitiveFields({})).toEqual({});
    expect(redactSensitiveFields([])).toEqual([]);
  });

  it("passes through primitives unchanged", () => {
    expect(redactSensitiveFields("hello")).toBe("hello");
    expect(redactSensitiveFields(42)).toBe(42);
    expect(redactSensitiveFields(true)).toBe(true);
    expect(redactSensitiveFields(null)).toBe(null);
    expect(redactSensitiveFields(undefined)).toBe(undefined);
  });

  it("redacts Stellar destination addresses embedded in free text", () => {
    const destination = "GA7QYNF7SOWQ3GLR2ZGMGIRKJ7F6NCWKUX6PS7LJVCUJUJQG2U5F6Z7P";
    const input = { detail: `submit failed for ${destination} with tx_bad_seq` };
    const output = redactSensitiveFields(input);
    expect(output.detail).toBe("submit failed for [REDACTED] with tx_bad_seq");
    expect(output.detail).not.toContain("GA7QYNF7");
  });

  it("redacts Stellar contract addresses embedded in free text", () => {
    const contract = "CA7QYNF7SOWQ3GLR2ZGMGIRKJ7F6NCWKUX6PS7LJVCUJUJQG2U5F6Z7P";
    const output = redactSensitiveFields({ detail: `contract call to ${contract} failed` });
    expect(output.detail).not.toContain(contract);
    expect(output.detail).toContain("[REDACTED]");
  });

  it("redacts memo values in sensitive keys and free-text assignments", () => {
    const input = { memo: "invoice-8817", detail: "payment memo=invoice-8817 rejected" };
    const output = redactSensitiveFields(input);
    expect(output.memo).toBe("[REDACTED]");
    expect(output.detail).toBe("payment memo=[REDACTED] rejected");
  });

  it("redacts signed_xdr and api_key object keys", () => {
    const input = {
      signed_xdr: "AAAA...long-envelope...==",
      api_key: "sk-live-abc",
      ApiKey: "sk-live-xyz",
    };
    const output = redactSensitiveFields(input);
    expect(output.signed_xdr).toBe("[REDACTED]");
    expect(output.api_key).toBe("[REDACTED]");
    expect(output.ApiKey).toBe("[REDACTED]");
  });

  it("redacts long signed XDR blobs embedded in error strings", () => {
    const signedXdr =
      "AAAAAgAAAABb/9mDlFqQbGUnkl4S5jgY6b0jI9kUhF1cVzYfVJB1XgAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABjX2WdAAAAAAAAAAEAAAAAAAAAAAAAAABjX2WdAAAAAQAAAAB0ZXN0LXR4bi1zaWduZWQteGRyLXJlZGFjdGlvbgAAAAAAAAEAAAAAAAAAAQAAAADZm5Rkr8lEAUGJ3N8VnUXB1c1S5GFjtWJpVbFzL0fJZwAAAAA=";
    const input = { detail: `submit failed: ${signedXdr} (tx_bad_seq)` };
    const output = redactSensitiveFields(input);
    expect(output.detail).not.toContain(signedXdr);
    expect(output.detail).toContain("[REDACTED] (tx_bad_seq)");
  });

  it("redacts api_key=, token= and Bearer assignments inside free text", () => {
    const input = {
      detail:
        "horizon rejected api_key=sk-live-abc123 token=xyz789 Authorization: Bearer aaa.bbb.ccc",
    };
    const output = redactSensitiveFields(input);
    expect(output.detail).toBe(
      "horizon rejected api_key=[REDACTED] token=[REDACTED] Authorization: [REDACTED]"
    );
  });

  it("redacts JSON-style signedXdr values inside serialized free text", () => {
    const longXdr = "x".repeat(120);
    const input = { detail: `{"signedXdr":"${longXdr}","ok":false}` };
    const output = redactSensitiveFields(input);
    expect(output.detail).not.toContain(longXdr);
    expect(output.detail).toContain("signedXdr");
  });

  it("leaves ordinary route and short free-text messages unchanged", () => {
    const input = {
      detail: "tx_bad_seq: sequence number mismatch on /api/stellar/submit-signed",
      route: "/api/decision",
    };
    const output = redactSensitiveFields(input);
    expect(output.detail).toBe(input.detail);
    expect(output.route).toBe(input.route);
  });
});

describe("redactMetricText", () => {
  const wallet = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";

  it("redacts sensitive key/value pairs in error text", () => {
    expect(redactMetricText("submit failed token=abc123")).toBe("submit failed token=[REDACTED]");
    expect(redactMetricText("error: secret=s3cret-value")).toBe("error: secret=[REDACTED]");
    expect(redactMetricText("xdr='AAAA signed payload'")).toBe("xdr=[REDACTED]");
    expect(redactMetricText("GROQ_API_KEY=sk-live-123")).toBe("GROQ_API_KEY=[REDACTED]");
  });

  it("redacts destination and memo values in error text", () => {
    expect(redactMetricText(`payment rejected destination=${wallet}`)).toBe(
      "payment rejected destination=[REDACTED]"
    );
    expect(redactMetricText("payment rejected memo: hello-world")).toBe(
      "payment rejected memo: [REDACTED]"
    );
  });

  it("redacts bare wallet addresses", () => {
    expect(redactMetricText(`horizon error for ${wallet} at op 1`)).toBe(
      "horizon error for [REDACTED] at op 1"
    );
  });

  it("redacts bearer tokens", () => {
    expect(redactMetricText("auth failed: Bearer abc.def.ghi")).toBe(
      "auth failed: Bearer [REDACTED]"
    );
  });

  it("collapses embedded newlines so a help line stays single-line", () => {
    expect(redactMetricText("line one\nline two\r\nline three")).toBe(
      "line one line two line three"
    );
  });

  it("preserves plain help text unchanged", () => {
    expect(redactMetricText("Total API requests by route/method")).toBe(
      "Total API requests by route/method"
    );
    expect(redactMetricText("")).toBe("");
  });
});
