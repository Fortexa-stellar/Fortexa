import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: () => ({
    ok: true as const,
    session: {
      userId: "operator-csv-test",
      email: "operator@fortexa.local",
      role: "operator" as const,
      sid: "sid-csv-test",
      exp: Math.floor(Date.now() / 1000) + 120,
    },
  }),
}));

vi.mock("@/lib/storage/audit-store", () => ({
  validateAuditFilter: () => null,
  listAuditEntries: async () => [],
  listAllAuditEntriesByUser: async () => ({
    "operator-csv-test": [],
  }),
}));

vi.mock("@/lib/audit/hash-chain", () => ({
  AuditChainError: class AuditChainError extends Error {
    code: string;
    details?: Record<string, unknown>;
    constructor(code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  verifyAuditChain: () => ({
    result: { valid: true as const, checkedCount: 0, legacyCount: 0 },
    boundaries: { genesisHash: "0".repeat(64), headHash: "0".repeat(64), count: 0 },
  }),
}));

vi.mock("@/lib/audit/redact", () => ({
  redactAuditExportPayload: <T>(rows: T) => rows,
  redactAuditExportEntriesByUser: <T>(entries: T) => entries,
}));

import { GET } from "@/app/api/audit/export/route";

describe("GET /api/audit/export CSV anti-sniffing headers (#342)", () => {
  it("sets explicit Content-Type, attachment Content-Disposition, and X-Content-Type-Options: nosniff on scope=mine CSV export", async () => {
    const req = new NextRequest("http://localhost/api/audit/export?format=csv&scope=mine", {
      method: "GET",
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename=fortexa-audit-mine-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets explicit Content-Type, attachment Content-Disposition, and X-Content-Type-Options: nosniff on scope=all CSV export", async () => {
    const req = new NextRequest("http://localhost/api/audit/export?format=csv&scope=all", {
      method: "GET",
    });
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename=fortexa-audit-all-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
