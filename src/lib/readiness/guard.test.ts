import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getReadiness = vi.fn();

vi.mock("@/lib/readiness/checks", () => ({
  getReadiness: (...args: unknown[]) => getReadiness(...args),
}));

import { readinessBlockResponse } from "./guard";

const request = () => new NextRequest("http://localhost/api/decision", { method: "POST" });

const readyResult = {
  ready: true,
  failing: [],
  checks: { migration: "pass", policy_store: "pass", network: "pass" },
};

describe("readinessBlockResponse", () => {
  beforeEach(() => {
    getReadiness.mockReset();
  });

  it("does nothing outside production", async () => {
    const res = await readinessBlockResponse(request(), "/api/decision", Date.now(), undefined, {
      NODE_ENV: "development",
    } as NodeJS.ProcessEnv);
    expect(res).toBeNull();
    expect(getReadiness).not.toHaveBeenCalled();
  });

  it("lets the request through in production when ready", async () => {
    getReadiness.mockResolvedValue(readyResult);
    const res = await readinessBlockResponse(request(), "/api/decision", Date.now(), undefined, {
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(res).toBeNull();
  });

  it("returns 503 naming the failing check when the passphrase mismatches", async () => {
    getReadiness.mockResolvedValue({
      ready: false,
      failing: ["network"],
      checks: { migration: "pass", policy_store: "pass", network: "fail" },
    });

    const res = await readinessBlockResponse(request(), "/api/decision", Date.now(), undefined, {
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);

    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.ready).toBe(false);
    expect(body.failing).toEqual(["network"]);
  });

  it("names the migration check for a stale migration", async () => {
    getReadiness.mockResolvedValue({
      ready: false,
      failing: ["migration"],
      checks: { migration: "fail", policy_store: "pass", network: "pass" },
    });

    const res = await readinessBlockResponse(request(), "/api/decision", Date.now(), undefined, {
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);

    const body = await res!.json();
    expect(res!.status).toBe(503);
    expect(body.failing).toEqual(["migration"]);
  });
});
