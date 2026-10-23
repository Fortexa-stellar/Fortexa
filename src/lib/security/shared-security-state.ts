import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Redis from "ioredis";

import { hasEmbeddedCredentials } from "@/lib/validation/remote-urls";

export type SharedRateLimitState = {
  count: number;
  resetAt: number;
};

export type SharedLockoutState = {
  attempts: number;
  lockedUntilMs: number;
};

export type SharedChallengeState = {
  publicKey: string;
  message: string;
  expiresAtMs: number;
  consumed: boolean;
};

export type SharedSessionRevocationState = {
  revokedAtMs: number;
  expiresAtMs: number;
};

type SharedSecurityState = {
  rateLimits: Record<string, SharedRateLimitState>;
  lockouts: Record<string, SharedLockoutState>;
  challenges: Record<string, SharedChallengeState>;
  revokedSessions: Record<string, SharedSessionRevocationState>;
};

const defaultState: SharedSecurityState = {
  rateLimits: {},
  lockouts: {},
  challenges: {},
  revokedSessions: {},
};

let redisClient: Redis | null = null;
let isRedisUnreachable = false;

function getRedisClient(): Redis | null {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return null;
  }

  if (hasEmbeddedCredentials(redisUrl)) {
    console.error("REDIS_URL must not contain embedded username or password credentials.");
    isRedisUnreachable = true;
    return null;
  }

  if (!redisClient) {
    try {
      redisClient = new Redis(redisUrl, {
        connectTimeout: 1000,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        username: process.env.REDIS_USERNAME?.trim() || undefined,
        password: process.env.REDIS_PASSWORD?.trim() || undefined,
      });

      redisClient.on("error", (err) => {
        console.error("Redis connection error:", err);
        isRedisUnreachable = true;
      });

      redisClient.on("connect", () => {
        isRedisUnreachable = false;
      });
    } catch (err) {
      console.error("Failed to initialize Redis client:", err);
      isRedisUnreachable = true;
    }
  }

  return redisClient;
}

export function resetRedisClient() {
  if (redisClient) {
    try {
      redisClient.disconnect();
    } catch {
      // ignore
    }
    redisClient = null;
  }
  isRedisUnreachable = false;
}

function getSharedStatePath() {
  const configured = process.env.FORTEXA_SHARED_STATE_PATH?.trim();
  if (!configured) {
    return null;
  }

  if (path.isAbsolute(configured)) {
    return configured;
  }

  const relativeBase = process.env.VERCEL === "1" ? "/tmp" : process.cwd();
  return path.join(relativeBase, configured);
}

export function isSharedSecurityStateEnabled() {
  const redisUrl = process.env.REDIS_URL?.trim();
  const validRedis = Boolean(redisUrl && !hasEmbeddedCredentials(redisUrl));
  return validRedis || Boolean(getSharedStatePath());
}

function readSharedState(): SharedSecurityState {
  const filePath = getSharedStatePath();
  if (!filePath) {
    return defaultState;
  }

  try {
    if (!existsSync(filePath)) {
      return defaultState;
    }

    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SharedSecurityState>;

    return {
      rateLimits: parsed.rateLimits ?? {},
      lockouts: parsed.lockouts ?? {},
      challenges: parsed.challenges ?? {},
      revokedSessions: parsed.revokedSessions ?? {},
    };
  } catch {
    return defaultState;
  }
}

function writeSharedState(next: SharedSecurityState) {
  const filePath = getSharedStatePath();
  if (!filePath) {
    return;
  }

  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
  renameSync(tempPath, filePath);
}

async function runWithRedisFallback<T>(
  redisOp: (client: Redis) => Promise<T>,
  fileOp: () => T
): Promise<T> {
  const client = getRedisClient();
  if (client && !isRedisUnreachable) {
    try {
      return await redisOp(client);
    } catch (error) {
      console.warn("Redis operation failed, falling back to file store:", error);
    }
  }
  return fileOp();
}

export async function readSharedRateLimit(key: string): Promise<SharedRateLimitState | undefined> {
  return runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:rate-limit:${key}`;
      const raw = await client.get(redisKey);
      if (!raw) {
        return undefined;
      }
      return JSON.parse(raw) as SharedRateLimitState;
    },
    () => readSharedState().rateLimits[key]
  );
}

/**
 * Atomically consumes one slot from a shared rate-limit bucket (issue #202).
 *
 * The read-then-write pattern used elsewhere is not safe under concurrency:
 * two parallel requests can both read `count = limit - 1` and both pass the
 * last allowed slot. This operation moves the decision and the increment
 * into a single step per backend:
 *
 * - Redis: an EVAL script (GET, decide, SET with TTL) is atomic per script,
 *   so parallel requests serialize against the same counter.
 * - File: a synchronous read-modify-write (the process-level lock in the
 *   caller serializes writers within one instance; the atomic rename keeps
 *   the file intact for other readers).
 *
 * Returns the post-decision state plus whether this call was allowed.
 */
export async function consumeSharedRateLimit(
  key: string,
  config: { limit: number; windowMs: number }
): Promise<{ allowed: boolean; state: SharedRateLimitState }> {
  const runFileOp = (): { allowed: boolean; state: SharedRateLimitState } => {
    const now = Date.now();
    const current = readSharedState().rateLimits[key];

    let next: SharedRateLimitState;
    if (!current || now >= current.resetAt) {
      next = { count: 1, resetAt: now + config.windowMs };
    } else if (current.count >= config.limit) {
      return { allowed: false, state: current };
    } else {
      next = { count: current.count + 1, resetAt: current.resetAt };
    }

    const state = readSharedState();
    state.rateLimits[key] = next;
    writeSharedState(state);

    return { allowed: true, state: next };
  };

  return runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:rate-limit:${key}`;
      const now = Date.now();

      // KEYS[1] = bucket key, ARGV: limit, windowMs, now
      // Returns: { allowed (1/0), count, resetAt }
      const script = `
        local raw = redis.call('GET', KEYS[1])
        local count = 0
        local resetAt = 0
        if raw then
          local ok, parsed = pcall(cjson.decode, raw)
          if ok and type(parsed) == 'table' then
            count = tonumber(parsed.count) or 0
            resetAt = tonumber(parsed.resetAt) or 0
          end
        end
        if resetAt > 0 and tonumber(ARGV[3]) >= resetAt then
          count = 0
          resetAt = 0
        end
        if count >= tonumber(ARGV[1]) then
          return {0, count, resetAt}
        end
        count = count + 1
        if resetAt == 0 then
          resetAt = tonumber(ARGV[3]) + tonumber(ARGV[2])
        end
        local ttl = math.max(1, math.ceil((resetAt - tonumber(ARGV[3])) / 1000))
        redis.call('SET', KEYS[1], cjson.encode({count = count, resetAt = resetAt}), 'EX', ttl)
        return {1, count, resetAt}
      `;

      const result = (await client.eval(
        script,
        1,
        redisKey,
        String(config.limit),
        String(config.windowMs),
        String(now),
      )) as [number, number, number];

      const [allowed, count, resetAt] = result;
      return {
        allowed: allowed === 1,
        state: { count, resetAt },
      };
    },
    runFileOp
  );
}

export async function writeSharedRateLimit(key: string, value: SharedRateLimitState): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:rate-limit:${key}`;
      const now = Date.now();
      const ttlSeconds = Math.max(1, Math.ceil((value.resetAt - now) / 1000));
      await client.set(redisKey, JSON.stringify(value), "EX", ttlSeconds);
    },
    () => {
      const current = readSharedState();
      current.rateLimits[key] = value;
      writeSharedState(current);
    }
  );
}

export async function clearSharedRateLimits(): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const keys = await client.keys("fortexa:rate-limit:*");
      if (keys.length > 0) {
        await client.del(keys);
      }
    },
    () => {
      const current = readSharedState();
      current.rateLimits = {};
      writeSharedState(current);
    }
  );
}

export async function readSharedLockout(key: string): Promise<SharedLockoutState | undefined> {
  return runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:lockout:${key}`;
      const raw = await client.get(redisKey);
      if (!raw) {
        return undefined;
      }
      return JSON.parse(raw) as SharedLockoutState;
    },
    () => readSharedState().lockouts[key]
  );
}

export async function writeSharedLockout(key: string, value: SharedLockoutState): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:lockout:${key}`;
      const now = Date.now();
      let ttlSeconds = 86400; // 24 hours fallback
      if (value.lockedUntilMs > now) {
        ttlSeconds = Math.max(1, Math.ceil((value.lockedUntilMs - now) / 1000));
      }
      await client.set(redisKey, JSON.stringify(value), "EX", ttlSeconds);
    },
    () => {
      const current = readSharedState();
      current.lockouts[key] = value;
      writeSharedState(current);
    }
  );
}

export async function removeSharedLockout(key: string): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:lockout:${key}`;
      await client.del(redisKey);
    },
    () => {
      const current = readSharedState();
      delete current.lockouts[key];
      writeSharedState(current);
    }
  );
}

export async function clearSharedLockouts(): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const keys = await client.keys("fortexa:lockout:*");
      if (keys.length > 0) {
        await client.del(keys);
      }
    },
    () => {
      const current = readSharedState();
      current.lockouts = {};
      writeSharedState(current);
    }
  );
}

export async function readSharedChallenge(key: string): Promise<SharedChallengeState | undefined> {
  return runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:challenge:${key}`;
      const raw = await client.get(redisKey);
      if (!raw) {
        return undefined;
      }
      return JSON.parse(raw) as SharedChallengeState;
    },
    () => readSharedState().challenges[key]
  );
}

/** Atomically remove a challenge before its signature is checked. */
export async function takeSharedChallenge(key: string): Promise<SharedChallengeState | undefined> {
  return runWithRedisFallback(
    async (client) => {
      const raw = await client.getdel(`fortexa:challenge:${key}`);
      return raw ? JSON.parse(raw) as SharedChallengeState : undefined;
    },
    () => {
      const filePath = getSharedStatePath();
      if (!filePath) return undefined;

      // A per-challenge claim serializes attempts across processes using the file store.
      const claimPath = `${filePath}.challenge-${key}.claim`;
      try {
        closeSync(openSync(claimPath, "wx"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw error;
      }

      try {
        const current = readSharedState();
        const challenge = current.challenges[key];
        if (challenge) {
          delete current.challenges[key];
          writeSharedState(current);
        }
        return challenge;
      } finally {
        rmSync(claimPath, { force: true });
      }
    }
  );
}

export async function writeSharedChallenge(
  key: string,
  value: SharedChallengeState,
  ttlSeconds: number
): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:challenge:${key}`;
      await client.set(redisKey, JSON.stringify(value), "EX", Math.max(1, ttlSeconds));
    },
    () => {
      const current = readSharedState();
      current.challenges[key] = value;
      writeSharedState(current);
    }
  );
}

export async function deleteSharedChallenge(key: string): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const redisKey = `fortexa:challenge:${key}`;
      await client.del(redisKey);
    },
    () => {
      const current = readSharedState();
      delete current.challenges[key];
      writeSharedState(current);
    }
  );
}

export async function clearSharedChallenges(): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const keys = await client.keys("fortexa:challenge:*");
      if (keys.length > 0) {
        await client.del(keys);
      }
    },
    () => {
      const current = readSharedState();
      current.challenges = {};
      writeSharedState(current);
    }
  );
}

export async function readSharedSessionRevocation(
  sessionId: string
): Promise<SharedSessionRevocationState | undefined> {
  return runWithRedisFallback(
    async (client) => {
      const raw = await client.get(`fortexa:session-revoked:${sessionId}`);
      if (!raw) {
        return undefined;
      }
      return JSON.parse(raw) as SharedSessionRevocationState;
    },
    () => readSharedState().revokedSessions[sessionId]
  );
}

export async function writeSharedSessionRevocation(
  sessionId: string,
  value: SharedSessionRevocationState
): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const ttlSeconds = Math.max(1, Math.ceil((value.expiresAtMs - Date.now()) / 1000));
      await client.set(`fortexa:session-revoked:${sessionId}`, JSON.stringify(value), "EX", ttlSeconds);
    },
    () => {
      const current = readSharedState();
      const now = Date.now();
      // The file store has no TTL, so drop revocations that can no longer
      // match a live token while writing a new one.
      for (const [key, entry] of Object.entries(current.revokedSessions)) {
        if (entry.expiresAtMs <= now) {
          delete current.revokedSessions[key];
        }
      }
      current.revokedSessions[sessionId] = value;
      writeSharedState(current);
    }
  );
}

export async function clearSharedSessionRevocations(): Promise<void> {
  await runWithRedisFallback(
    async (client) => {
      const keys = await client.keys("fortexa:session-revoked:*");
      if (keys.length > 0) {
        await client.del(keys);
      }
    },
    () => {
      const current = readSharedState();
      current.revokedSessions = {};
      writeSharedState(current);
    }
  );
}

export async function clearSharedSecurityStateFile(): Promise<void> {
  const filePath = getSharedStatePath();
  if (filePath) {
    try {
      rmSync(filePath, { force: true });
    } catch (err) {
      console.error("Failed to delete shared state file:", err);
    }
  }

  const client = getRedisClient();
  if (client && !isRedisUnreachable) {
    try {
      const keys = await client.keys("fortexa:*");
      if (keys.length > 0) {
        await client.del(keys);
      }
    } catch (err) {
      console.warn("Failed to clear Redis keys in clearSharedSecurityStateFile:", err);
    }
  }
}
