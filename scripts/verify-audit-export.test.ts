import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { extractExportPayload } from "./verify-audit-export";
import { verifyHashChain } from "../src/lib/audit/hash-chain";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"));
}

describe("extractExportPayload", () => {
  it("accepts a plain array", () => {
    const data = [{ id: "e1" }, { id: "e2" }];
    const result = extractExportPayload(data);
    expect(result.entries).toEqual(data);
    expect(result.entriesByUser).toBeNull();
  });

  it("accepts scope=mine object", () => {
    const entries = [{ id: "e1" }];
    const result = extractExportPayload({ scope: "mine", entries });
    expect(result.entries).toEqual(entries);
    expect(result.entriesByUser).toBeNull();
  });

  it("accepts scope=all object", () => {
    const data = { scope: "all", entriesByUser: { "user-a": [{ id: "e1" }] } };
    const result = extractExportPayload(data);
    expect(result.entriesByUser).toEqual({ "user-a": [{ id: "e1" }] });
    expect(result.entries).toBeNull();
  });

  it("accepts object with entries key and no scope", () => {
    const entries = [{ id: "e1" }];
    const result = extractExportPayload({ entries });
    expect(result.entries).toEqual(entries);
  });

  it("throws on null input", () => {
    expect(() => extractExportPayload(null)).toThrow("Unrecognized export format");
  });

  it("throws on unrecognized object shape", () => {
    expect(() => extractExportPayload({ foo: "bar" })).toThrow("Unrecognized export format");
  });

  it("throws when entriesByUser value is not an array", () => {
    expect(() =>
      extractExportPayload({ scope: "all", entriesByUser: { "user-a": "bad" } })
    ).toThrow("is not an array");
  });
});

describe("fixtures — valid chains", () => {
  it("valid-chain.json: plain array verifies successfully", () => {
    const { entries } = extractExportPayload(loadFixture("valid-chain.json"));
    expect(entries).not.toBeNull();
    const result = verifyHashChain(entries!);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.checkedCount).toBe(3);
  });

  it("valid-mine-export.json: scope=mine verifies successfully", () => {
    const { entries } = extractExportPayload(loadFixture("valid-mine-export.json"));
    expect(entries).not.toBeNull();
    const result = verifyHashChain(entries!);
    expect(result.valid).toBe(true);
  });

  it("valid-chain-csv-quoting.json: CSV-hostile row is still a valid chain", () => {
    const extracted = extractExportPayload(loadFixture("valid-chain-csv-quoting.json"));
    expect(extracted.entries).not.toBeNull();
    const result = verifyHashChain(extracted.entries!, extracted.chainBoundary);
    expect(result.valid).toBe(true);
  });

  it("valid-all-export.json: scope=all — every user chain is valid", () => {
    const { entriesByUser } = extractExportPayload(loadFixture("valid-all-export.json"));
    expect(entriesByUser).not.toBeNull();
    for (const entries of Object.values(entriesByUser!)) {
      expect(verifyHashChain(entries).valid).toBe(true);
    }
  });
});

describe("fixtures — tamper detection", () => {
  it("tampered-field.json: detects modified entry content (entryHash mismatch)", () => {
    const { entries } = extractExportPayload(loadFixture("tampered-field.json"));
    const result = verifyHashChain(entries!);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("entryHash mismatch");
  });

  it("deleted-entry.json: detects a removed entry (previousHash mismatch)", () => {
    const { entries } = extractExportPayload(loadFixture("deleted-entry.json"));
    const result = verifyHashChain(entries!);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toContain("previousHash mismatch");
  });

  it("reordered-entries.json: detects timestamp-swapped reordering", () => {
    const { entries } = extractExportPayload(loadFixture("reordered-entries.json"));
    const result = verifyHashChain(entries!);
    expect(result.valid).toBe(false);
  });
});
