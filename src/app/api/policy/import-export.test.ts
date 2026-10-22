import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET, POST } from "@/app/api/policy/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { exportPolicyDocument, type PolicyExport } from "@/lib/policy/import-export";
import type { PolicyConfig } from "@/lib/types/domain";
import fixture from "@/lib/policy/__fixtures__/default.json";

type Active = { policy: PolicyConfig; version: number };
const store = vi.hoisted(() => ({
  active: null as Active | null,
  update: vi.fn(),
}));

vi.mock("@/lib/storage/policy-store", () => ({
  getPolicyConfig: async () => store.active,
  updatePolicyConfig: store.update,
  PolicyVersionConflict: class extends Error {},
}));

function request(method: "GET" | "POST", body?: unknown) {
  process.env.FORTEXA_AUTH_SECRET = "policy-import-test-secret";
  const token = createSessionToken({
    email: "policy-import@fortexa.local",
    role: "operator",
    userId: "policy-import-test",
    expiresInSeconds: 120,
  });

  return new NextRequest("http://localhost/api/policy", {
    method,
    headers: {
      cookie: `${AUTH_COOKIE_KEY}=${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-forwarded-for": "192.0.2.237",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function activePolicy(): Promise<Active> {
  const response = await GET(request("GET"));
  expect(response.status).toBe(200);
  return response.json() as Promise<Active>;
}

async function exportedFixture(): Promise<PolicyExport> {
  const active = await activePolicy();
  return exportPolicyDocument(active.policy, active.version);
}

describe("policy export import", () => {
  beforeEach(() => {
    store.active = { policy: structuredClone(fixture) as PolicyConfig, version: 237 };
    store.update.mockReset();
  });

  it("round trips a fixture with the same rule ids, order, and version", async () => {
    const document = await exportedFixture();
    expect(document.active).toBe(true);
    expect(document.policy).toEqual(fixture);

    const response = await POST(request("POST", JSON.parse(JSON.stringify(document))));
    expect(response.status).toBe(200);
    const after = (await response.json()) as Active;
    expect(after.policy).toEqual(document.policy);
    expect(after.version).toBe(document.version);
    expect(await activePolicy()).toMatchObject(after);
    expect(store.update).not.toHaveBeenCalled();
  });

  it("rejects a rewritten rule id and keeps the active policy", async () => {
    const document = await exportedFixture();
    const changed = {
      ...document,
      policy: {
        ...document.policy,
        allowedTools: ["rewritten-id", ...document.policy.allowedTools.slice(1)],
      },
    };

    const response = await POST(request("POST", changed));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/rule identifiers or order/);
    expect(await activePolicy()).toMatchObject({
      policy: document.policy,
      version: document.version,
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("rejects reordered rule ids and keeps the active policy", async () => {
    const document = await exportedFixture();
    const changed = {
      ...document,
      policy: { ...document.policy, blockedDomains: [...document.policy.blockedDomains].reverse() },
    };

    const response = await POST(request("POST", changed));
    expect(response.status).toBe(422);
    expect(await activePolicy()).toMatchObject({
      policy: document.policy,
      version: document.version,
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("rejects a changed export version and keeps the active policy", async () => {
    const document = await exportedFixture();
    const response = await POST(request("POST", { ...document, version: document.version + 1 }));
    expect(response.status).toBe(409);
    expect(await activePolicy()).toMatchObject({
      policy: document.policy,
      version: document.version,
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("rejects an inactive export and keeps the active policy", async () => {
    const document = await exportedFixture();
    const response = await POST(request("POST", { ...document, active: false }));
    expect(response.status).toBe(422);
    expect(await activePolicy()).toMatchObject({
      policy: document.policy,
      version: document.version,
    });
    expect(store.update).not.toHaveBeenCalled();
  });

  it("runs migration and schema validation before accepting an import", async () => {
    const document = await exportedFixture();
    const olderPolicy = { ...document.policy };
    delete olderPolicy.allowedHours;
    const migrated = await POST(request("POST", { ...document, policy: olderPolicy }));
    expect(migrated.status).toBe(200);
    expect((await migrated.json()).policy).toEqual(document.policy);
    expect(await activePolicy()).toMatchObject({
      policy: document.policy,
      version: document.version,
    });

    const malformed = await POST(
      request("POST", {
        ...document,
        policy: { ...document.policy, perTxCapXLM: "invalid" },
      })
    );
    expect(malformed.status).toBe(422);
    expect(await activePolicy()).toMatchObject({
      policy: document.policy,
      version: document.version,
    });
    expect(store.update).not.toHaveBeenCalled();
  });
});
