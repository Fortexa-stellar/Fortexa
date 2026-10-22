import { describe, expect, it } from "vitest";
import { buildAuditExportFilename, sanitizeFilenameSegment } from "@/lib/audit/export-filename";

describe("sanitizeFilenameSegment", () => {
  it("passes through an already-safe segment unchanged", () => {
    expect(sanitizeFilenameSegment("all")).toBe("all");
  });

  it("strips a newline", () => {
    expect(sanitizeFilenameSegment("all\nX-Injected: 1")).toBe("allX-Injected: 1");
  });

  it("strips a carriage return and newline (CRLF header injection attempt)", () => {
    expect(sanitizeFilenameSegment("all\r\nSet-Cookie: evil=1")).toBe("allSet-Cookie: evil=1");
  });

  it("strips double quotes", () => {
    expect(sanitizeFilenameSegment('all"; filename="evil')).toBe("all; filename=evil");
  });

  it("strips backslashes and forward slashes", () => {
    expect(sanitizeFilenameSegment("../../etc\\passwd")).toBe("....etcpasswd");
  });

  it("strips a null byte and other control characters", () => {
    expect(sanitizeFilenameSegment("all\x00\x01\x7f")).toBe("all");
  });

  it("falls back to a safe default when nothing survives sanitization", () => {
    expect(sanitizeFilenameSegment("\n\r\x00")).toBe("export");
  });
});

describe("buildAuditExportFilename", () => {
  it("builds the expected name for scope=all, format=csv", () => {
    const name = buildAuditExportFilename("all", "csv", new Date("2026-10-22T12:00:00.000Z"));
    expect(name).toBe("fortexa-audit-all-2026-10-22.csv");
  });

  it("builds the expected name for scope=mine, format=json", () => {
    const name = buildAuditExportFilename("mine", "json", new Date("2026-01-05T00:00:00.000Z"));
    expect(name).toBe("fortexa-audit-mine-2026-01-05.json");
  });

  it("defaults to csv when format is omitted", () => {
    const name = buildAuditExportFilename("all", undefined, new Date("2026-10-22T12:00:00.000Z"));
    expect(name).toBe("fortexa-audit-all-2026-10-22.csv");
  });

  it("never contains a newline or carriage return even with a hostile cast past the type system", () => {
    const hostileScope = "all\r\nX-Injected: 1" as unknown as Parameters<typeof buildAuditExportFilename>[0];
    const name = buildAuditExportFilename(hostileScope, "csv", new Date("2026-10-22T12:00:00.000Z"));
    expect(name).not.toMatch(/[\r\n]/);
  });
});
