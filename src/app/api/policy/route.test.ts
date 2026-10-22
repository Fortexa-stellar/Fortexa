import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { Networks } from "@stellar/stellar-sdk";

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { DEFAULT_JSON_BODY_MAX_BYTES } from "@/lib/http/read-json-body";
import { getStellarNetworkFingerprint } from "@/lib/stellar/network-config";
import { GET, POST } from "@/app/api/policy/route";

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "operator@fortexa.local",
    role: "operator",
    userId: "operator-user-id",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function viewerCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "viewer@fortexa.local",
    role: "viewer",
    userId: "viewer-user-id",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function signerCookie() {
  process.env.FORTEXA_AUTH_SECRET = "integration-test-secret";
  const token = createSessionToken({
    email: "signer@fortexa.local",
    role: "signer",
    userId: "signer-user-id",
    expiresInSeconds: 120,
  });

  return `${AUTH_COOKIE_KEY}=${token}`;
}

function makePolicyGetRequest(cookie: string) {
  return new NextRequest("http://localhost/api/policy", {
    method: "GET",
    headers: { cookie },
  });
}

function makePolicyPostRequest(cookie: string, body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/policy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(body),
  });
}

const POLICY_PAYLOAD = {
  allowedDomains: ["api.example.com"],
  blockedDomains: ["malicious.com"],
  allowedTools: ["research-pro"],
  blockedTools: ["shadow-shell"],
  perTxCapXLM: 150,
  dailyCapXLM: 300,
  maxToolCallsPerDay: 10,
  riskThreshold: 80,
  allowedHours: { start: 6, end: 23 },
};

describe("/api/policy route", () => {
  it("rejects secret-shaped payload fields before saving", async () => {
    const response = await POST(
      makePolicyPostRequest(operatorCookie(), {
        ...POLICY_PAYLOAD,
        auth: { sessionToken: "fixture-token" },
      })
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("sensitive field");
  });

  it("rejects saves when the server Horizon and passphrase disagree", async () => {
    const previousHorizon = process.env.STELLAR_HORIZON_URL;
    const previousPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
    process.env.STELLAR_HORIZON_URL = "https://horizon.stellar.org";
    process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET;
    try {
      const response = await POST(makePolicyPostRequest(operatorCookie(), POLICY_PAYLOAD));
      expect(response.status).toBe(409);
    } finally {
      if (previousHorizon === undefined) delete process.env.STELLAR_HORIZON_URL;
      else process.env.STELLAR_HORIZON_URL = previousHorizon;
      if (previousPassphrase === undefined) delete process.env.STELLAR_NETWORK_PASSPHRASE;
      else process.env.STELLAR_NETWORK_PASSPHRASE = previousPassphrase;
    }
  });

  it("rejects a stale settings page after the server network changes", async () => {
    const previousHorizon = process.env.STELLAR_HORIZON_URL;
    const previousPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
    process.env.STELLAR_HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.STELLAR_NETWORK_PASSPHRASE = Networks.TESTNET;
    const displayedFingerprint = getStellarNetworkFingerprint();
    process.env.STELLAR_HORIZON_URL = "https://horizon.stellar.org";
    process.env.STELLAR_NETWORK_PASSPHRASE = Networks.PUBLIC;
    try {
      const response = await POST(
        new NextRequest("http://localhost/api/policy", {
          method: "POST",
          headers: {
            cookie: operatorCookie(),
            "content-type": "application/json",
            "x-fortexa-network-fingerprint": displayedFingerprint,
          },
          body: JSON.stringify(POLICY_PAYLOAD),
        })
      );
      expect(response.status).toBe(409);
    } finally {
      if (previousHorizon === undefined) delete process.env.STELLAR_HORIZON_URL;
      else process.env.STELLAR_HORIZON_URL = previousHorizon;
      if (previousPassphrase === undefined) delete process.env.STELLAR_NETWORK_PASSPHRASE;
      else process.env.STELLAR_NETWORK_PASSPHRASE = previousPassphrase;
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/policy", { method: "GET" });
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns 200 for viewer reading policy (read access allowed)", async () => {
    const request = new NextRequest("http://localhost/api/policy", {
      method: "GET",
      headers: { cookie: viewerCookie() },
    });
    const response = await GET(request);

    expect(response.status).toBe(200);

    const payload = (await response.json()) as { policy: unknown };
    expect(payload.policy).toBeDefined();
  });

  it("returns 403 for viewer attempting policy update (operator-only)", async () => {
    const request = new NextRequest("http://localhost/api/policy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie(),
      },
      body: JSON.stringify({
        allowedDomains: [],
        blockedDomains: [],
        allowedTools: [],
        blockedTools: [],
        perTxCapXLM: 100,
        dailyCapXLM: 500,
        maxToolCallsPerDay: 10,
        riskThreshold: 70,
        allowedHours: { start: 0, end: 23 },
      }),
    });
    const response = await POST(request);

    expect(response.status).toBe(403);
  });

  it("returns 403 for signer-only policy updates", async () => {
    const response = await POST(makePolicyPostRequest(signerCookie(), POLICY_PAYLOAD));
    expect(response.status).toBe(403);
  });

  it("allows operator to update and read policy", async () => {
    const cookie = operatorCookie();

    // Seed with no expectedVersion to remain backward compatible.
    const response = await POST(makePolicyPostRequest(cookie, POLICY_PAYLOAD));
    expect(response.status).toBe(200);

    const readResponse = await GET(makePolicyGetRequest(cookie));
    expect(readResponse.status).toBe(200);

    const payload = (await readResponse.json()) as {
      policy: { perTxCapXLM: number; riskThreshold: number };
      version: number;
    };

    expect(payload.policy.perTxCapXLM).toBe(150);
    expect(payload.policy.riskThreshold).toBe(80);
    expect(typeof payload.version).toBe("number");
  });

  it("accepts a save that includes the current expectedVersion (200) and advances the version", async () => {
    const cookie = operatorCookie();

    const initialRead = await GET(makePolicyGetRequest(cookie));
    const initialPayload = (await initialRead.json()) as { version: number };

    const response = await POST(
      makePolicyPostRequest(cookie, {
        ...POLICY_PAYLOAD,
        perTxCapXLM: 175,
        expectedVersion: initialPayload.version,
      })
    );

    expect(response.status).toBe(200);
    const saved = (await response.json()) as {
      policy: { perTxCapXLM: number };
      version: number;
    };

    expect(saved.policy.perTxCapXLM).toBe(175);
    expect(saved.version).toBe(initialPayload.version + 1);
  });

  it("rejects a stale save (mismatched expectedVersion) with 409 and does not advance the version", async () => {
    const cookie = operatorCookie();

    // Bring the server to a known fresh state.
    const seed = await POST(makePolicyPostRequest(cookie, POLICY_PAYLOAD));
    expect(seed.status).toBe(200);
    const seedBody = (await seed.json()) as { version: number };

    // First operator saves successfully, bumping the version by one.
    const firstSave = await POST(
      makePolicyPostRequest(cookie, {
        ...POLICY_PAYLOAD,
        perTxCapXLM: 200,
        expectedVersion: seedBody.version,
      })
    );
    expect(firstSave.status).toBe(200);
    const firstSaveBody = (await firstSave.json()) as { version: number };
    expect(firstSaveBody.version).toBe(seedBody.version + 1);

    // Second operator's save is still based on the old (stale) version — reject.
    const staleSave = await POST(
      makePolicyPostRequest(cookie, {
        ...POLICY_PAYLOAD,
        perTxCapXLM: 999,
        expectedVersion: seedBody.version,
      })
    );

    expect(staleSave.status).toBe(409);
    const conflict = (await staleSave.json()) as {
      code: string;
      error: string;
      expectedVersion: number;
      currentVersion: number;
      currentUpdatedAt: string | null;
    };

    expect(conflict.code).toBe("POLICY_VERSION_CONFLICT");
    expect(conflict.expectedVersion).toBe(seedBody.version);
    expect(conflict.currentVersion).toBe(firstSaveBody.version);
    expect(typeof conflict.currentUpdatedAt).toBe("string");

    // The stale save must NOT have changed the live version.
    const verifyRead = await GET(makePolicyGetRequest(cookie));
    const verifyBody = (await verifyRead.json()) as {
      policy: { perTxCapXLM: number };
      version: number;
    };
    expect(verifyBody.version).toBe(firstSaveBody.version);
    expect(verifyBody.policy.perTxCapXLM).toBe(200);
  });

  it("accepts an omitted expectedVersion for backward compatibility", async () => {
    const cookie = operatorCookie();

    // No `expectedVersion` provided — should succeed and bump the version.
    const response = await POST(
      makePolicyPostRequest(cookie, {
        ...POLICY_PAYLOAD,
        perTxCapXLM: 222,
      })
    );

    expect(response.status).toBe(200);
    const saved = (await response.json()) as {
      policy: { perTxCapXLM: number };
      version: number;
    };
    expect(saved.policy.perTxCapXLM).toBe(222);
    expect(typeof saved.version).toBe("number");
  });

  it("rejects an invalid expectedVersion with 400", async () => {
    const cookie = operatorCookie();

    const response = await POST(
      makePolicyPostRequest(cookie, {
        ...POLICY_PAYLOAD,
        expectedVersion: -1,
      })
    );

    expect(response.status).toBe(400);
  });

  it("returns 413 for oversized JSON payloads before validation", async () => {
    const cookie = operatorCookie();
    const padding = "x".repeat(DEFAULT_JSON_BODY_MAX_BYTES);
    const updateRequest = new NextRequest("http://localhost/api/policy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: `{"allowedDomains":["${padding}"]}`,
    });

    const response = await POST(updateRequest);
    expect(response.status).toBe(413);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toContain("byte limit");
  });

  it("returns validation error for malformed small JSON", async () => {
    const cookie = operatorCookie();
    const updateRequest = new NextRequest("http://localhost/api/policy", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: "{not-json",
    });

    const response = await POST(updateRequest);
    expect(response.status).toBe(400);

    const payload = (await response.json()) as { error: string };
    expect(payload.error).toBe("Invalid policy payload.");
  });

  it("rejects a cap with more fractional digits than the asset allows", async () => {
    const cookie = operatorCookie();
    const response = await POST(
      makePolicyPostRequest(cookie, {
        ...POLICY_PAYLOAD,
        perTxCapXLM: 1.12345678,
      })
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: string;
      details?: { fieldErrors?: { perTxCapXLM?: string[] } };
    };
    expect(payload.error).toBe("Invalid policy payload.");
    expect(payload.details?.fieldErrors?.perTxCapXLM).toContain(
      "Amount has more decimal places than the asset allows."
    );
  });
});
