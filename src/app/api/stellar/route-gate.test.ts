import { Keypair } from "@stellar/stellar-sdk";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.FORTEXA_STORE_DIR = `/tmp/fortexa-route-gate-${Date.now()}`;
  process.env.FORTEXA_AUTH_SECRET = "route-gate-test-secret";
  delete process.env.DATABASE_URL;
});

const stellar = vi.hoisted(() => ({
  getNativeBalance: vi.fn(),
  buildUnsignedPaymentTransaction: vi.fn(),
  submitSignedTransactionXdr: vi.fn(),
}));
const blocklist = vi.hoisted(() => ({ checkBlocklist: vi.fn() }));

vi.mock("@/lib/stellar/client", () => stellar);
vi.mock("@/lib/security/blocklist", () => blocklist);

import { GET as balanceGet } from "@/app/api/stellar/balance/route";
import { POST as fundPost } from "@/app/api/stellar/fund/route";
import { POST as payPost } from "@/app/api/stellar/pay/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import { upsertUserWallet } from "@/lib/storage/user-wallet-store";

const wallet = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();

function cookie(userId = "gate-user") {
  const token = createSessionToken({
    email: "gate@fortexa.local",
    role: "operator",
    userId,
    expiresInSeconds: 300,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

function req(url: string, method: string, body?: unknown, authed = true) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", ...(authed ? { cookie: cookie() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const payBody = {
  auditEntryId: "00000000-0000-4000-8000-000000000000",
  destination,
  amountXLM: "5",
};

function expectStellarUntouched() {
  expect(stellar.getNativeBalance).not.toHaveBeenCalled();
  expect(stellar.buildUnsignedPaymentTransaction).not.toHaveBeenCalled();
  expect(stellar.submitSignedTransactionXdr).not.toHaveBeenCalled();
}

describe("stellar balance/fund/pay decision gate", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    blocklist.checkBlocklist.mockResolvedValue({ allow: true, reasonCode: null });
    await upsertUserWallet("gate-user", {
      publicKey: wallet,
      source: "external",
      provider: "freighter",
    });
  });

  it("rejects unauthenticated calls on all routes without touching Stellar", async () => {
    const b = await balanceGet(req("http://x/api/stellar/balance", "GET", undefined, false));
    const f = await fundPost(req("http://x/api/stellar/fund", "POST", {}, false));
    const p = await payPost(req("http://x/api/stellar/pay", "POST", payBody, false));
    expect([b.status, f.status, p.status]).toEqual([401, 401, 401]);
    expect(blocklist.checkBlocklist).not.toHaveBeenCalled();
    expectStellarUntouched();
  });

  it("rejects blocklisted destinations on all routes", async () => {
    blocklist.checkBlocklist.mockResolvedValue({ allow: false, reasonCode: "BLOCKLIST_MATCH" });
    const b = await balanceGet(req("http://x/api/stellar/balance", "GET"));
    const f = await fundPost(req("http://x/api/stellar/fund", "POST", { destination }));
    const p = await payPost(req("http://x/api/stellar/pay", "POST", payBody));
    expect([b.status, f.status, p.status]).toEqual([403, 403, 403]);
    expectStellarUntouched();
  });

  it("rejects pay without a matching allow decision", async () => {
    const res = await payPost(req("http://x/api/stellar/pay", "POST", payBody));
    expect(res.status).toBe(403);
    expectStellarUntouched();
  });
});
