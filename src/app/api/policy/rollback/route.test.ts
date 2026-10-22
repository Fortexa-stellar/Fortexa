import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { POST } from "@/app/api/policy/rollback/route";
import { updatePolicyConfig } from "@/lib/storage/policy-store";
import { appendAuditEntry, resetAuditState } from "@/lib/storage/audit-store";
import {
  putIdempotencyRecord,
  resetSubmitIdempotencyState,
} from "@/lib/storage/submit-idempotency-store";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import { randomUUID } from "node:crypto";

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: "policy-rollback-operator",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function signerCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "signer@fortexa.local",
    role: "signer",
    userId: "policy-rollback-signer",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

describe("/api/policy/rollback route", () => {
  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/policy/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetVersion: 1 }),
    });

    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("allows operator rollback to version 1", async () => {
    const request = new NextRequest("http://localhost/api/policy/rollback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: JSON.stringify({ targetVersion: 1 }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
  });

  it("rejects a rollback payload carrying a session token", async () => {
    const request = new NextRequest("http://localhost/api/policy/rollback", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: operatorCookie() },
      body: JSON.stringify({ targetVersion: 1, sessionToken: "fixture-token" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects rollback from a stale settings page", async () => {
    const request = new NextRequest("http://localhost/api/policy/rollback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
        "x-fortexa-network-fingerprint": "stale",
      },
      body: JSON.stringify({ targetVersion: 1 }),
    });

    const response = await POST(request);
    expect(response.status).toBe(409);
  });
});
