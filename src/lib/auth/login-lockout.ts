import {
  clearSharedLockouts,
  isSharedSecurityStateEnabled,
  readSharedLockout,
  removeSharedLockout,
  writeSharedLockout,
} from "@/lib/security/shared-security-state";

type LockoutRecord = {
  attempts: number;
  lockedUntilMs: number;
};

const records = new Map<string, LockoutRecord>();

export type Clock = () => number;

let clock: Clock = () => Date.now();

export function setLoginLockoutClock(nextClock: Clock) {
  clock = nextClock;
}

export function resetLoginLockoutClock() {
  clock = () => Date.now();
}

function nowMs() {
  return clock();
}

function getMaxAttempts() {
  const parsed = Number(process.env.FORTEXA_AUTH_MAX_ATTEMPTS ?? 5);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 5;
  }
  return Math.floor(parsed);
}

function getLockMinutes() {
  const parsed = Number(process.env.FORTEXA_AUTH_LOCK_MINUTES ?? 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 10;
  }
  return parsed;
}

function keyOf(email: string, ip: string) {
  return `${email.trim().toLowerCase()}::${ip}`;
}

export function readClientIp(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }

  return headers.get("x-real-ip")?.trim() ?? "unknown";
}

export async function isLoginLocked(email: string, ip: string) {
  const key = keyOf(email, ip);
  const useSharedState = isSharedSecurityStateEnabled();
  const record = useSharedState ? await readSharedLockout(key) : records.get(key);

  if (!record) {
    return { locked: false as const, retryAfterSeconds: 0 };
  }

  const now = nowMs();
  if (record.lockedUntilMs <= now) {
    if (useSharedState) {
      await removeSharedLockout(key);
    } else {
      records.delete(key);
    }
    return { locked: false as const, retryAfterSeconds: 0 };
  }

  return {
    locked: true as const,
    retryAfterSeconds: Math.max(1, Math.ceil((record.lockedUntilMs - now) / 1000)),
  };
}

export async function registerLoginFailure(email: string, ip: string) {
  const now = nowMs();
  const maxAttempts = getMaxAttempts();
  const lockMs = Math.max(1000, getLockMinutes() * 60 * 1000);
  const useSharedState = isSharedSecurityStateEnabled();

  const key = keyOf(email, ip);
  const current = (useSharedState ? await readSharedLockout(key) : records.get(key)) ?? {
    attempts: 0,
    lockedUntilMs: 0,
  };
  current.attempts += 1;

  if (current.attempts >= maxAttempts) {
    current.lockedUntilMs = now + lockMs;
  }

  if (useSharedState) {
    await writeSharedLockout(key, current);
  } else {
    records.set(key, current);
  }

  return {
    attempts: current.attempts,
    lockedUntilMs: current.lockedUntilMs,
    justLocked: current.lockedUntilMs > now,
  };
}

export async function clearLoginFailures(email: string, ip: string) {
  const key = keyOf(email, ip);
  if (isSharedSecurityStateEnabled()) {
    await removeSharedLockout(key);
    return;
  }

  records.delete(key);
}

export async function resetLoginLockoutStore() {
  records.clear();
  if (isSharedSecurityStateEnabled()) {
    await clearSharedLockouts();
  }
}
