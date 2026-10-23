import { describe, expect, it } from "vitest";
import { escapeCsvCell, sanitizeCsvCell, toCsv } from "@/utils/csv.utils";

describe("sanitizeCsvCell", () => {
  it("prepends a single quote for dangerous prefixes", () => {
    const inputs = ["=SUM(A1)", "+1", "-foo", "@bar"];
    const expected = ["'=SUM(A1)", "'+1", "'-foo", "'@bar"]; // note the leading single quote
    inputs.forEach((input, idx) => {
      expect(sanitizeCsvCell(input)).toBe(expected[idx]);
    });
  });

  it("leaves safe strings unchanged", () => {
    expect(sanitizeCsvCell("Hello World")).toBe("Hello World");
    expect(sanitizeCsvCell("12345")).toBe("12345");
    expect(sanitizeCsvCell("=")).toBe("'="); // even a single '=' should be quoted
  });

  it("converts null/undefined to empty string", () => {
    expect(sanitizeCsvCell(null)).toBe("");
    expect(sanitizeCsvCell(undefined)).toBe("");
  });
});

describe("escapeCsvCell", () => {
  it("quotes every cell and doubles embedded double quotes", () => {
    expect(escapeCsvCell("plain")).toBe('"plain"');
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("keeps commas and quotes inside a single quoted cell", () => {
    // Round-trips through the same quoting rules a spreadsheet parser applies.
    const escaped = escapeCsvCell('Approved by ops, note: "temporary exception"');
    expect(escaped).toBe('"Approved by ops, note: ""temporary exception"""');
  });

  it("serializes redaction placeholders as JSON instead of [object Object]", () => {
    expect(escapeCsvCell({ $redacted: "token" })).toBe('"{""$redacted"":""token""}"');
  });

  it("still hardens formula prefixes", () => {
    expect(escapeCsvCell("=1+1")).toBe('"\'=1+1"');
  });
});

describe("toCsv", () => {
  it("returns an empty body when there are no rows", () => {
    expect(toCsv([])).toBe("");
  });

  it("emits a header and one line per row", () => {
    const csv = toCsv([
      { id: "entry-1", explanation: "Within policy limits" },
      { id: "entry-2", explanation: 'Approved by ops, note: "temporary exception"' },
    ]);

    expect(csv).toBe(
      [
        "id,explanation",
        '"entry-1","Within policy limits"',
        '"entry-2","Approved by ops, note: ""temporary exception"""',
        "",
      ].join("\n")
    );
  });

  it("keeps a comma/quote-bearing value inside one column", () => {
    const csv = toCsv([{ id: "entry-1", actionName: 'pay, "urgent"' }]);
    const [header, row] = csv.trimEnd().split("\n");

    // The value is emitted as a single quoted cell with doubled quotes, so a
    // CSV-aware parser recovers exactly two columns despite the embedded comma.
    expect(header).toBe("id,actionName");
    expect(row).toBe('"entry-1","pay, ""urgent"""');
  });
});
