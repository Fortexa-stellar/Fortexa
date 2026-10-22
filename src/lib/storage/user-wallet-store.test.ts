import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  getUserWallet,
  upsertUserWallet,
  revokeUserWallet,
  WalletAlreadyBoundError,
} from "./user-wallet-store";
import { getWalletFromSession } from "@/lib/auth/session-wallet";
import { getFortexaStoreDir } from "./paths";

// Ensure tests use the fallback JSON store by bypassing Postgres if we don't configure it.
// The existing app logic falls back to JSON if db is unavailable.

describe("user-wallet-store (fallback)", () => {
  const storePath = path.join(getFortexaStoreDir(), "wallets.json");

  beforeEach(async () => {
    // ensure empty store before each test
    await fs.mkdir(getFortexaStoreDir(), { recursive: true }).catch(() => {});
    await fs.writeFile(storePath, JSON.stringify({ wallets: {} }), "utf8").catch(() => {});
  });

  afterEach(async () => {
    await fs.unlink(storePath).catch(() => {});
  });

  it("returns null for missing mapping", async () => {
    const wallet = await getUserWallet("missing-user");
    expect(wallet).toBeNull();
  });

  it("upserts and returns a valid session mapping", async () => {
    const wallet = await upsertUserWallet("user-1", {
      publicKey: "GDEV123",
      source: "external",
      provider: "test",
    });

    expect(wallet.userId).toBe("user-1");
    expect(wallet.publicKey).toBe("GDEV123");
    expect(wallet.expiresAt).toBeDefined();

    const fetched = await getUserWallet("user-1");
    expect(fetched).not.toBeNull();
    if (fetched && !("expired" in fetched)) {
      expect(fetched.publicKey).toBe("GDEV123");
    } else {
      expect.fail("Expected a valid UserWallet");
    }
  });

  it("allows the same owner to bind the same key again without a duplicate", async () => {
    await upsertUserWallet("user-1", { publicKey: "GDEV123", source: "external" });
    await upsertUserWallet("user-1", {
      publicKey: "GDEV123",
      source: "external",
      provider: "again",
    });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      wallets: Record<string, unknown>;
    };
    expect(Object.keys(store.wallets)).toEqual(["user-1"]);
  });

  it("rejects a second owner and serializes concurrent binds", async () => {
    await upsertUserWallet("user-1", { publicKey: "GDEV123", source: "external" });
    await expect(
      upsertUserWallet("user-2", { publicKey: "GDEV123", source: "external" })
    ).rejects.toBeInstanceOf(WalletAlreadyBoundError);

    await revokeUserWallet("user-1");
    const concurrent = await Promise.allSettled([
      upsertUserWallet("user-2", { publicKey: "GDEV456", source: "external" }),
      upsertUserWallet("user-3", { publicKey: "GDEV456", source: "external" }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("identifies expired session mappings", async () => {
    // Insert with expiration in the past
    await upsertUserWallet("user-2", {
      publicKey: "GDEV456",
      source: "external",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const fetched = await getUserWallet("user-2");
    expect(fetched).toEqual({ expired: true });
  });

  it("revokes session mappings deterministically", async () => {
    await upsertUserWallet("user-3", {
      publicKey: "GDEV789",
      source: "external",
    });

    let fetched = await getUserWallet("user-3");
    expect(fetched).not.toBeNull();
    expect(fetched).not.toEqual({ expired: true });

    await revokeUserWallet("user-3");

    fetched = await getUserWallet("user-3");
    expect(fetched).toBeNull();
    await expect(
      getWalletFromSession({ userId: "user-3", email: "wallet:GDEV789" })
    ).resolves.toBeNull();
  });
});
