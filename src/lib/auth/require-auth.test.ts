import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { requireAuth } from "@/lib/auth/require-auth";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";

function requestWithRoles(roles: ("operator" | "signer" | "viewer")[]) {
  process.env.FORTEXA_AUTH_SECRET = "role-gate-test-secret";
  const token = createSessionToken({
    email: "wallet@fortexa.local",
    role: roles.includes("operator") ? "operator" : roles[0],
    roles,
    userId: "role-gate-wallet",
  });
  return new NextRequest("http://localhost/api/role-test", {
    headers: { cookie: `${AUTH_COOKIE_KEY}=${token}` },
  });
}

describe("wallet role authorization", () => {
  it("does not allow a signer-only wallet to edit policy", () => {
    const result = requireAuth(requestWithRoles(["signer"]), { allowedRoles: ["operator"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("does not allow an operator-only wallet to submit payments", () => {
    const result = requireAuth(requestWithRoles(["operator"]), { allowedRoles: ["signer"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("allows a dual-role wallet through both independent gates", () => {
    const request = requestWithRoles(["operator", "signer"]);
    expect(requireAuth(request, { allowedRoles: ["operator"] }).ok).toBe(true);
    expect(requireAuth(request, { allowedRoles: ["signer"] }).ok).toBe(true);
  });
});
