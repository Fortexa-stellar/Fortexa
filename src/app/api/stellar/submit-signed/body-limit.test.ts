import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/stellar/submit-signed/route";
import { POST as LoginPOST } from "@/app/api/auth/login/route";
import { POST as PolicyPOST } from "@/app/api/policy/route";
import { POST as RollbackPOST } from "@/app/api/policy/rollback/route";
import { POST as DecisionPOST } from "@/app/api/decision/route";

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { DEFAULT_JSON_BODY_MAX_BYTES } from "@/lib/http/read-json-body";

function signerCookie() {
  process.env.FORTEXA_AUTH_SECRET = "submit-signed-body-limit-secret";
  const token = createSessionToken({
    email: "signer@fortexa.local",
    role: "signer",
    userId: "submit-signed-body-limit-operator",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "submit-signed-body-limit-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: "submit-signed-body-limit-operator",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

describe("POST /api/stellar/submit-signed body limits", () => {
  it("returns 413 for oversized JSON payloads", async () => {
    const padding = "x".repeat(DEFAULT_JSON_BODY_MAX_BYTES);
    const request = new NextRequest("http://localhost/api/stellar/submit-signed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: signerCookie(),
      },
      body: `{"signedXdr":"${padding}"}`,
    });

    const response = await POST(request);
    expect(response.status).toBe(413);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("byte limit");
  });

  it("returns validation error for malformed small JSON", async () => {
    const request = new NextRequest("http://localhost/api/stellar/submit-signed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: signerCookie(),
      },
      body: "{not-json",
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Invalid signed transaction submission.");
  });
});

describe("POST /api/stellar/submit-signed validation redaction", () => {
  it("does not echo signedXdr values in validation error responses", async () => {
    const secretXdr = "LEAK_XDR_SECRET";
    const request = new NextRequest("http://localhost/api/stellar/submit-signed", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: signerCookie(),
      },
      body: JSON.stringify({ signedXdr: secretXdr }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const raw = await response.text();
    expect(raw).not.toContain(secretXdr);

    const payload = JSON.parse(raw) as { details?: { fieldErrors?: Record<string, string[]> } };
    expect(payload.details?.fieldErrors?.signedXdr).toEqual(["Invalid value."]);
  });
});

describe("Body limits for other mutating routes", () => {
  const payloadStr = "x".repeat(DEFAULT_JSON_BODY_MAX_BYTES);

  it("returns 413 for oversized JSON payloads on login", async () => {
    const request = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"publicKey":"G123","challengeId":"123","signature":"${payloadStr}"}`,
    });
    const response = await LoginPOST(request);
    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error).toContain("byte limit");
  });

  it("returns 413 for oversized JSON payloads on policy create", async () => {
    const request = new NextRequest("http://localhost/api/policy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: `{"version": 1, "allowedDomains": ["${payloadStr}"]}`,
    });
    const response = await PolicyPOST(request);
    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error).toContain("byte limit");
  });

  it("returns 413 for oversized JSON payloads on policy rollback", async () => {
    const request = new NextRequest("http://localhost/api/policy/rollback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: `{"targetVersion": 1, "reason": "${payloadStr}"}`,
    });
    const response = await RollbackPOST(request);
    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error).toContain("byte limit");
  });

  it("returns 413 for oversized JSON payloads on decision", async () => {
    const request = new NextRequest("http://localhost/api/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: operatorCookie(),
      },
      body: `{"action": {"id":"123","name":"test","kind":"api_payment","target":"svc","domain":"${payloadStr}","amountXLM":10}}`,
    });
    const response = await DecisionPOST(request);
    expect(response.status).toBe(413);
    const payload = await response.json();
    expect(payload.error).toContain("byte limit");
  });
});
