import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

delete process.env.DATABASE_URL;
process.env.FORTEXA_AUTH_SECRET = "stellar-pay-route-test-secret-356";
if (process.env.FORTEXA_STORE_DIR) {
  mkdirSync(process.env.FORTEXA_STORE_DIR, { recursive: true });
}

import { POST as payPost } from "@/app/api/stellar/pay/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { checkBlocklist } from "@/lib/security/blocklist";
import { buildDecisionReceipt } from "@/lib/stellar/verify-payment-quote";
import {
  appendAuditEntry,
  getAuditEntryById,
  resetAuditState,
} from "@/lib/storage/audit-store";
import type { AuditEntry } from "@/lib/types/domain";

// Mock blocklist so we can deterministically test blocklisted destinations
vi.mock("@/lib/security/blocklist", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/security/blocklist")
  >("@/lib/security/blocklist");
  return {
    ...actual,
    checkBlocklist: vi.fn(async (destination: string) => {
      if (destination.includes("BLOCKED")) {
        return { allow: false, source: "mock-blocklist" };
      }
      return actual.checkBlocklist(destination);
    }),
  };
});

// Mock audit store getAuditEntryById for internal error simulation
vi.mock("@/lib/storage/audit-store", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/storage/audit-store")
  >("@/lib/storage/audit-store");
  return {
    ...actual,
    getAuditEntryById: vi.fn(actual.getAuditEntryById),
  };
});

const SIGNER_USER_ID = "usr_signer_356";
const OPERATOR_USER_ID = "usr_operator_356";
const VIEWER_USER_ID = "usr_viewer_356";

function createCookie(role: "signer" | "operator" | "viewer", userId: string) {
  const token = createSessionToken({
    email: `${role}@fortexa.local`,
    role,
    userId,
    expiresInSeconds: 3600,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function buildPayRequest(
  body: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  const reqHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...headers,
  };
  if (cookie) {
    reqHeaders["cookie"] = cookie;
  }
  return new NextRequest("http://localhost/api/stellar/pay", {
    method: "POST",
    headers: reqHeaders,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/stellar/pay direct route tests (#356)", () => {
  const validDestination = Keypair.random().publicKey();

  beforeEach(async () => {
    if (process.env.FORTEXA_STORE_DIR) {
      mkdirSync(process.env.FORTEXA_STORE_DIR, { recursive: true });
    }
    await resetAuditState(SIGNER_USER_ID);
    vi.clearAllMocks();
  });

  // ── 1. Unauthenticated Access ──────────────────────────────────────────────
  describe("Unauthenticated access", () => {
    it("rejects requests missing an auth session cookie with 401 Unauthorized", async () => {
      const payload = {
        auditEntryId: randomUUID(),
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload);
      const response = await payPost(request);

      expect(response.status).toBe(401);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toBeDefined();
    });
  });

  // ── 2. Role Denial ─────────────────────────────────────────────────────────
  describe("Role authorization and denial", () => {
    it("rejects requests from viewer role with 403 Forbidden", async () => {
      const viewerCookie = createCookie("viewer", VIEWER_USER_ID);
      const payload = {
        auditEntryId: randomUUID(),
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload, viewerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(403);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toMatch(/insufficient|forbidden|role/i);
    });

    it("rejects requests from operator role without signer capability with 403 Forbidden", async () => {
      const operatorCookie = createCookie("operator", OPERATOR_USER_ID);
      const payload = {
        auditEntryId: randomUUID(),
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload, operatorCookie);
      const response = await payPost(request);

      expect(response.status).toBe(403);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toMatch(/insufficient|forbidden|role/i);
    });
  });

  // ── 3. Invalid JSON and Body Validation ────────────────────────────────────
  describe("Invalid JSON and payload validation", () => {
    it("rejects non-JSON or unparseable request body with 400", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const request = new NextRequest("http://localhost/api/stellar/pay", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: signerCookie,
        },
        body: "not-valid-json{{{",
      });

      const response = await payPost(request);
      expect(response.status).toBe(400);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toContain("Invalid pay request body");
    });

    it("rejects payload missing required fields (e.g. destination, amountXLM) with 400", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const invalidPayload = {
        auditEntryId: randomUUID(),
        // missing destination and amountXLM
      };

      const request = buildPayRequest(invalidPayload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(400);
      const json = (await response.json()) as {
        error?: string;
        details?: unknown;
      };
      expect(json.error).toContain("Invalid pay request body");
      expect(json.details).toBeDefined();
    });

    it("rejects invalid Stellar public key with 400", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const invalidPayload = {
        auditEntryId: randomUUID(),
        destination: "NOT_A_VALID_STELLAR_KEY",
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(invalidPayload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(400);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toContain("Invalid pay request body");
    });

    it("rejects login authorization payloads with 400", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const loginPayload = {
        auditEntryId: randomUUID(),
        destination: validDestination,
        amountXLM: "5.0000000",
        asset: "native",
        network: "testnet",
        challenge:
          "Fortexa wallet login\nOrigin: http://localhost\nNonce: 123456\nExpires: 2026-12-31T00:00:00.000Z",
      };

      const request = buildPayRequest(loginPayload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(400);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toBe("Login signatures cannot authorize a payment.");
    });
  });

  // ── 4. Policy and Quote Rejection ──────────────────────────────────────────
  describe("Policy and quote validation", () => {
    it("rejects payments to blocklisted destinations with 403 Forbidden", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const blockedDestination = "GBLOCKED" + "A".repeat(48);
      const payload = {
        auditEntryId: randomUUID(),
        destination: blockedDestination,
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(403);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toBe("Destination is blocklisted.");
    });

    it("rejects payment when audit entry does not exist with 403 Forbidden", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const nonExistentAuditId = randomUUID();
      const payload = {
        auditEntryId: nonExistentAuditId,
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(403);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toContain("No authorized payment decision found");
    });

    it("rejects payment when audit decision is BLOCK with 403 Forbidden", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const auditId = randomUUID();
      const blockedEntry: AuditEntry = {
        id: auditId,
        timestamp: new Date().toISOString(),
        action: {
          tool: "stellar_pay",
          parameters: { destination: validDestination, amount: "15.0000000" },
        },
        decision: "BLOCK",
        explanation: "Risk threshold exceeded",
        triggeredPolicies: ["MAX_AMOUNT"],
        riskFindings: ["High risk transfer"],
      };

      await appendAuditEntry(SIGNER_USER_ID, blockedEntry);

      const payload = {
        auditEntryId: auditId,
        destination: validDestination,
        amountXLM: "15.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(403);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toContain(
        "Decision 'BLOCK' does not authorize payment execution",
      );
    });

    it("rejects payment when requested amount mismatches quote with 403 Forbidden", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const auditId = randomUUID();
      const quote = buildDecisionReceipt({
        destination: validDestination,
        amountXLM: "20.0000000",
        asset: "native",
        memo: "fortexa:quote-1",
        network: "testnet",
      });

      const approvedEntry: AuditEntry = {
        id: auditId,
        timestamp: new Date().toISOString(),
        action: {
          tool: "stellar_pay",
          parameters: { destination: validDestination, amount: "20.0000000" },
        },
        decision: "APPROVE",
        explanation: "Authorized quote test",
        triggeredPolicies: [],
        riskFindings: [],
        paymentQuote: quote,
      };

      await appendAuditEntry(SIGNER_USER_ID, approvedEntry);

      // Attempt payment with a different tampered amount
      const payload = {
        auditEntryId: auditId,
        destination: validDestination,
        amountXLM: "25.0000000", // Tampered!
        asset: "native",
        memo: "fortexa:quote-1",
        network: "testnet",
      };

      const request = buildPayRequest(payload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(403);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toMatch(/amount|quote|mismatch/i);
    });
  });

  // ── 5. Safe Upstream Failure Mapping & Disabled Notice ─────────────────────
  describe("Safe upstream mapping and disabled notice", () => {
    it("returns safe 400 disabled notice with signed-XDR migration guidance when quote is valid", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      const auditId = randomUUID();
      const quote = buildDecisionReceipt({
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        memo: "fortexa:quote-safe",
        network: "testnet",
      });

      const approvedEntry: AuditEntry = {
        id: auditId,
        timestamp: new Date().toISOString(),
        action: {
          tool: "stellar_pay",
          parameters: { destination: validDestination, amount: "10.0000000" },
        },
        decision: "APPROVE",
        explanation: "Valid pre-approved payment",
        triggeredPolicies: [],
        riskFindings: [],
        paymentQuote: quote,
      };

      await appendAuditEntry(SIGNER_USER_ID, approvedEntry);

      const payload = {
        auditEntryId: auditId,
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        memo: "fortexa:quote-safe",
        network: "testnet",
      };

      const request = buildPayRequest(payload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(400);
      const json = (await response.json()) as {
        error?: string;
        userId?: string;
      };
      expect(json.error).toContain("Direct pay endpoint is disabled");
      expect(json.error).toContain(
        "/api/stellar/build-payment + /api/stellar/submit-signed",
      );
      expect(json.userId).toBe(SIGNER_USER_ID);
    });

    it("maps unexpected runtime errors safely to HTTP 500 without leaking stack traces", async () => {
      const signerCookie = createCookie("signer", SIGNER_USER_ID);
      // Mock getAuditEntryById to throw an unexpected error
      vi.mocked(getAuditEntryById).mockRejectedValueOnce(
        new Error("Database connection timed out during audit lookup"),
      );

      const payload = {
        auditEntryId: randomUUID(),
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload, signerCookie);
      const response = await payPost(request);

      expect(response.status).toBe(500);
      const json = (await response.json()) as { error?: string };
      expect(json.error).toBe(
        "Database connection timed out during audit lookup",
      );
    });
  });

  // ── 6. Security Headers ───────────────────────────────────────────────────
  describe("Security headers enforcement", () => {
    it("attaches security headers to route responses", async () => {
      const payload = {
        auditEntryId: randomUUID(),
        destination: validDestination,
        amountXLM: "10.0000000",
        asset: "native",
        network: "testnet",
      };

      const request = buildPayRequest(payload);
      const response = await payPost(request);

      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-request-id")).toBeDefined();
    });
  });
});
