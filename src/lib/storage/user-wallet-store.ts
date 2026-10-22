import { promises as fs } from "node:fs";

import { runWithDatabase } from "@/lib/storage/db";
import { getFortexaStoreDir, getFortexaStorePath } from "@/lib/storage/paths";

export type UserWallet = {
  userId: string;
  publicKey: string;
  source: "external";
  provider?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};

type WalletStoreFile = {
  wallets: Record<string, UserWallet | { [key: string]: unknown }>;
};

const storePath = getFortexaStorePath("wallets.json");
let fallbackWriteQueue = Promise.resolve();

export class WalletAlreadyBoundError extends Error {
  constructor() {
    super("This Stellar wallet is already bound to another user.");
    this.name = "WalletAlreadyBoundError";
  }
}

function withFallbackWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = fallbackWriteQueue.then(operation, operation);
  fallbackWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function ensureStore() {
  await fs.mkdir(getFortexaStoreDir(), { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    const initial: WalletStoreFile = { wallets: {} };
    await fs.writeFile(storePath, JSON.stringify(initial, null, 2), "utf8");
  }
}

async function readStore(): Promise<WalletStoreFile> {
  await ensureStore();
  const raw = await fs.readFile(storePath, "utf8");
  const store = JSON.parse(raw) as WalletStoreFile;

  let migrated = false;
  for (const [userId, parsedWallet] of Object.entries(store.wallets)) {
    const wallet = parsedWallet as {
      source?: string;
      publicKey?: string;
      createdAt?: string;
      provider?: string;
      secret?: unknown;
      encryptedSecret?: unknown;
    };

    if (wallet.source !== "freighter" && wallet.source !== "external") {
      delete store.wallets[userId];
      migrated = true;
      continue;
    }

    if ("secret" in wallet || "encryptedSecret" in wallet) {
      store.wallets[userId] = {
        userId,
        publicKey: wallet.publicKey ?? "",
        source: "external",
        provider: wallet.source === "freighter" ? "freighter" : wallet.provider,
        createdAt: wallet.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      migrated = true;
    }

    if (wallet.source === "freighter") {
      store.wallets[userId] = {
        userId,
        publicKey: wallet.publicKey ?? "",
        source: "external",
        provider: "freighter",
        createdAt: wallet.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      migrated = true;
    }
  }

  if (migrated) {
    await writeStore(store);
  }

  return store;
}

async function writeStore(store: WalletStoreFile) {
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

export async function getUserWallet(
  userId: string
): Promise<UserWallet | { expired: true } | null> {
  const db = await runWithDatabase("getUserWallet", async (pool) => {
    const result = await pool.query<{
      user_id: string;
      public_key: string;
      source: string;
      provider: string | null;
      created_at: string;
      updated_at: string;
      expires_at: string | null;
    }>(
      `
        SELECT user_id, public_key, source, provider, created_at, updated_at, expires_at
        FROM fortexa_wallets
        WHERE user_id = $1
      `,
      [userId]
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return { expired: true as const };
    }

    return {
      userId: row.user_id,
      publicKey: row.public_key,
      source: "external" as const,
      provider: row.provider ?? undefined,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : undefined,
    };
  });

  if (db.available) {
    return db.value;
  }

  const store = await readStore();
  const wallet = store.wallets[userId];
  if (!wallet || typeof wallet !== "object" || !("source" in wallet) || !("publicKey" in wallet)) {
    return null;
  }
  const userWallet = wallet as UserWallet;
  if (userWallet.expiresAt && new Date(userWallet.expiresAt).getTime() < Date.now()) {
    return { expired: true as const };
  }
  return userWallet;
}

export async function upsertUserWallet(
  userId: string,
  payload: {
    publicKey: string;
    source: "external";
    provider?: string;
    expiresAt?: string;
  }
) {
  const publicKey = payload.publicKey.trim().toUpperCase();
  const db = await runWithDatabase("upsertUserWallet", async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [publicKey]);

      const owner = await client.query<{ user_id: string }>(
        `
          SELECT user_id
          FROM fortexa_wallets
          WHERE public_key = $1
            AND user_id <> $2
            AND (expires_at IS NULL OR expires_at > NOW())
          LIMIT 1
        `,
        [publicKey, userId]
      );

      if (owner.rows.length > 0) {
        await client.query("COMMIT");
        return { conflict: true as const };
      }

      const existing = await client.query<{ created_at: string }>(
        "SELECT created_at FROM fortexa_wallets WHERE user_id = $1",
        [userId]
      );
      const nowIso = new Date().toISOString();
      const createdAt = existing.rows[0]?.created_at
        ? new Date(existing.rows[0].created_at).toISOString()
        : nowIso;
      const expiresAt =
        payload.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      await client.query(
        `
          INSERT INTO fortexa_wallets (user_id, public_key, source, provider, created_at, updated_at, expires_at)
          VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)
          ON CONFLICT (user_id)
          DO UPDATE SET
            public_key = EXCLUDED.public_key,
            source = EXCLUDED.source,
            provider = EXCLUDED.provider,
            updated_at = EXCLUDED.updated_at,
            expires_at = EXCLUDED.expires_at
        `,
        [userId, publicKey, payload.source, payload.provider ?? null, createdAt, nowIso, expiresAt]
      );

      await client.query("COMMIT");
      return {
        userId,
        publicKey,
        source: payload.source,
        provider: payload.provider,
        createdAt,
        updatedAt: nowIso,
        expiresAt,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  if (db.available) {
    if ("conflict" in db.value) {
      throw new WalletAlreadyBoundError();
    }
    return db.value;
  }

  return withFallbackWriteLock(async () => {
    const store = await readStore();
    const now = new Date().toISOString();
    const current = store.wallets[userId] as UserWallet | undefined;
    const currentIsActive =
      Boolean(current) &&
      (!current.expiresAt || new Date(current.expiresAt).getTime() >= Date.now());
    const owner = Object.values(store.wallets).find((wallet) => {
      if (!wallet || typeof wallet !== "object" || !("publicKey" in wallet)) return false;
      const candidate = wallet as UserWallet;
      const active = !candidate.expiresAt || new Date(candidate.expiresAt).getTime() >= Date.now();
      return (
        candidate.userId !== userId &&
        candidate.publicKey.trim().toUpperCase() === publicKey &&
        active
      );
    });
    if (owner) {
      throw new WalletAlreadyBoundError();
    }

    const createdAt = currentIsActive ? current.createdAt : now;
    const expiresAt = payload.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const next: UserWallet = {
      userId,
      publicKey,
      source: payload.source,
      provider: payload.provider,
      createdAt,
      updatedAt: now,
      expiresAt,
    };

    store.wallets[userId] = next;
    await writeStore(store);
    return next;
  });
}

export async function revokeUserWallet(userId: string): Promise<void> {
  const db = await runWithDatabase("revokeUserWallet", async (pool) => {
    await pool.query(
      `
        DELETE FROM fortexa_wallets
        WHERE user_id = $1
      `,
      [userId]
    );
    return true;
  });

  if (db.available) {
    return;
  }

  const store = await readStore();
  if (store.wallets[userId]) {
    delete store.wallets[userId];
    await writeStore(store);
  }
}
