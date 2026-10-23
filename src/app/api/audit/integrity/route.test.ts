import { promises as fs } from "node:fs";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => {
  const tmpDir = `/tmp/fortexa-audit-integrity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.FORTEXA_STORE_DIR = tmpDir;
  process.env.FORTEXA_AUTH_SECRET = "audit-integrity-test-secret";
  delete process.env.DATABASE_URL;
});

import { GET } from "@/app/api/audit/integrity/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { appendAuditEntry, listAuditEntries, resetAuditState } from "@/lib/storage/audit-store";
import type { AuditEntry } from "@/lib/types/domain";

const OPERATOR_USER_ID = "integrity-operator";
const LEGACY_USER_ID = "integrity-legacy-user";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "entry-1",
    timestamp: "2024-01-01T00:00:00.000Z",
    action: {
      id: "action-1",
      name: "pay",
      kind: "api_payment",
      target: "GDEST",
      domain: "stellar.org",
      amountXLM: 1,
    },
    decision: "APPROVE",
    explanation: "ok",
    triggeredPolicies: [],
    riskFindings: [],
    ...overrides,
  };
}

function operatorCookie(userId = OPERATOR_USER_ID) {
  const token = createSessionToken({
    email: `${userId}@fortexa.local`,
    role: "operator",
    userId,
    expiresInSeconds: 120,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function viewerCookie() {
  const token = createSessionToken({
    email: "integrity-viewer@fortexa.local",
    role: "viewer",
    userId: "integrity-viewer",
    expiresInSeconds: 120,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function getRequest(url: string, cookie: string) {
  return new NextRequest(url, {
    method: "GET",
    headers: { cookie },
  });
}

async function seedChain(userId: string, count: number) {
  await resetAuditState(userId);
  for (let i = 0; i < count; i++) {
    await appendAuditEntry(
      userId,
      makeEntry({
        id: `${userId}-e${i + 1}`,
        timestamp: `2024-01-01T00:0${i}:00.000Z`,
      })
    );
  }
}

async function seedLegacy(userId: string) {
  await resetAuditState(userId);
  const dir = process.env.FORTEXA_STORE_DIR!;
  await fs.mkdir(dir, { recursive: true });
  const filePath = `${dir}/audit.json`;
  let existing: {
    auditByUser: Record<string, AuditEntry[]>;
    usageByUser: Record<string, unknown>;
  } = {
    auditByUser: {},
    usageByUser: {},
  };
  try {
    const raw = await fs.readFile(filePath, "utf8");
    existing = JSON.parse(raw);
    if (!existing.auditByUser) existing.auditByUser = {};
    if (!existing.usageByUser) existing.usageByUser = {};
  } catch {
    // File does not exist yet — start fresh.
  }
  existing.auditByUser[userId] = [
    makeEntry({
      id: `${userId}-legacy`,
      timestamp: "2023-01-01T00:00:00.000Z",
      action: {
        id: "legacy-action",
        name: "transfer",
        kind: "transfer",
        target: "GTARGET",
        domain: "legacy.example",
        amountXLM: 1,
      },
    }),
  ];
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2), "utf8");
}

async function overwriteStore(userId: string, entries: AuditEntry[]) {
  const dir = process.env.FORTEXA_STORE_DIR!;
  await fs.mkdir(dir, { recursive: true });
  const file = {
    auditByUser: { [userId]: entries },
    usageByUser: {},
  };
  await fs.writeFile(`${dir}/audit.json`, JSON.stringify(file, null, 2), "utf8");
}

afterAll(async () => {
  const dir = process.env.FORTEXA_STORE_DIR;
  if (dir && dir.startsWith("/tmp/fortexa-audit-integrity-")) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

beforeEach(async () => {
  await resetAuditState(OPERATOR_USER_ID);
  await resetAuditState(LEGACY_USER_ID);
});

describe("GET /api/audit/integrity", () => {
  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/audit/integrity", { method: "GET" });
    const response = await GET(request);
    expect(response.status).toBe(401);
  });

  it("returns valid with empty audit history", async () => {
    const response = await GET(
      getRequest("http://localhost/api/audit/integrity", operatorCookie())
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      valid: boolean;
      checkedEntries: number;
      legacyEntries: number;
      firstBrokenEntryId: string | null;
      reason: string | null;
      scope: string;
      userId: string;
      timestamp: string;
    };
    expect(payload.valid).toBe(true);
    expect(payload.checkedEntries).toBe(0);
    expect(payload.legacyEntries).toBe(0);
    expect(payload.firstBrokenEntryId).toBeNull();
    expect(payload.reason).toBeNull();
    expect(payload.scope).toBe("mine");
    expect(payload.userId).toBe(OPERATOR_USER_ID);
    expect(typeof payload.timestamp).toBe("string");
  });

  it("verifies a valid multi-entry chain (scope=mine)", async () => {
    await seedChain(OPERATOR_USER_ID, 3);
    const response = await GET(
      getRequest("http://localhost/api/audit/integrity", operatorCookie())
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      valid: boolean;
      checkedEntries: number;
    };
    expect(payload.valid).toBe(true);
    expect(payload.checkedEntries).toBe(3);
  });

  it("detects a tampered field as an entryHash mismatch", async () => {
    await seedChain(OPERATOR_USER_ID, 3);
    const stored = await listAuditEntries(OPERATOR_USER_ID);
    const asc = [...stored].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
    );
    const tampered = asc.map((entry, idx) =>
      idx === 1 ? { ...entry, explanation: "tampered" } : entry
    );
    await overwriteStore(OPERATOR_USER_ID, tampered);

    const response = await GET(
      getRequest("http://localhost/api/audit/integrity", operatorCookie())
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      valid: boolean;
      reason: string | null;
      firstBrokenEntryId: string | null;
    };
    expect(payload.valid).toBe(false);
    expect(payload.reason).toContain("entryHash");
    expect(payload.firstBrokenEntryId).toBe(`${OPERATOR_USER_ID}-e2`);
  });

  it("detects a missing entry as a previousHash mismatch", async () => {
    await seedChain(OPERATOR_USER_ID, 3);
    const stored = await listAuditEntries(OPERATOR_USER_ID);
    const asc = [...stored].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
    );
    // Drop the second entry — entry 3's previousHash now points to a vanished hash.
    const withGap = [asc[0], asc[2]].filter(Boolean) as AuditEntry[];
    await overwriteStore(OPERATOR_USER_ID, withGap);

    const response = await GET(
      getRequest("http://localhost/api/audit/integrity", operatorCookie())
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      valid: boolean;
      reason: string | null;
      firstBrokenEntryId: string | null;
    };
    expect(payload.valid).toBe(false);
    expect(payload.reason).toContain("previousHash");
    expect(payload.firstBrokenEntryId).toBe(`${OPERATOR_USER_ID}-e3`);
  });

  it("treats legacy entries without hash fields as valid (scope=mine)", async () => {
    await seedLegacy(LEGACY_USER_ID);
    const response = await GET(
      getRequest("http://localhost/api/audit/integrity", operatorCookie(LEGACY_USER_ID))
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      valid: boolean;
      checkedEntries: number;
      legacyEntries: number;
    };
    expect(payload.valid).toBe(true);
    expect(payload.checkedEntries).toBe(0);
    expect(payload.legacyEntries).toBeGreaterThanOrEqual(1);
  });

  it("returns 403 when viewer requests scope=all", async () => {
    const request = getRequest("http://localhost/api/audit/integrity?scope=all", viewerCookie());
    const response = await GET(request);
    expect(response.status).toBe(403);
  });

  it("allows operator scope=all and aggregates across users", async () => {
    await seedChain(OPERATOR_USER_ID, 2);
    await seedLegacy(LEGACY_USER_ID);

    const response = await GET(
      getRequest("http://localhost/api/audit/integrity?scope=all", operatorCookie())
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      valid: boolean;
      checkedEntries: number;
      legacyEntries: number;
      scope: string;
    };
    expect(payload.valid).toBe(true);
    expect(payload.scope).toBe("all");
    expect(payload.checkedEntries).toBe(2);
    expect(payload.legacyEntries).toBeGreaterThanOrEqual(1);
  });

  it("returns 400 for an unknown scope value", async () => {
    const response = await GET(
      getRequest("http://localhost/api/audit/integrity?scope=everyone", operatorCookie())
    );
    expect(response.status).toBe(400);
  });
});
