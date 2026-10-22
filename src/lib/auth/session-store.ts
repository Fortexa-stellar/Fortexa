export type SessionRecord = {
  key: string;
  userId: string;
  generation: number;
  revoked: boolean;
  expiresAtMs: number;
};

export type SessionRotationResult =
  { ok: true; generation: number } | { ok: false; reason: "revoked" | "stale" };

export type SessionIdentity = {
  userId: string;
  sessionId?: string | null;
};

const records = new Map<string, SessionRecord>();

const REVOCATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const REVOKED_GENERATION = Number.MAX_SAFE_INTEGER;

let lastPrunedAtMs = 0;

export function sessionRecordKey(identity: SessionIdentity) {
  return identity.sessionId ? `sid:${identity.sessionId}` : `user:${identity.userId}`;
}

function pruneExpiredSessions(nowMs: number) {
  if (nowMs - lastPrunedAtMs < PRUNE_INTERVAL_MS) {
    return;
  }
  lastPrunedAtMs = nowMs;

  for (const [key, record] of records) {
    if (record.expiresAtMs <= nowMs) {
      records.delete(key);
    }
  }
}

export function registerSession(
  identity: SessionIdentity & { generation: number; expiresAtMs: number }
): void {
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);

  const key = sessionRecordKey(identity);
  const existing = records.get(key);
  if (existing?.revoked) {
    return;
  }

  records.set(key, {
    key,
    userId: identity.userId,
    generation: identity.generation,
    revoked: false,
    expiresAtMs: identity.expiresAtMs,
  });
}

export function rotateSessionGeneration(
  identity: SessionIdentity & { currentGeneration: number; expiresAtMs: number }
): SessionRotationResult {
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);

  const key = sessionRecordKey(identity);
  const existing = records.get(key);

  if (existing?.revoked) {
    return { ok: false, reason: "revoked" };
  }

  if (existing && existing.generation !== identity.currentGeneration) {
    return { ok: false, reason: "stale" };
  }

  const generation = identity.currentGeneration + 1;
  records.set(key, {
    key,
    userId: identity.userId,
    generation,
    revoked: false,
    expiresAtMs: identity.expiresAtMs,
  });

  return { ok: true, generation };
}

export function isSessionGenerationCurrent(
  identity: SessionIdentity & { generation: number }
): boolean {
  const record = records.get(sessionRecordKey(identity));

  if (!record) {
    return true;
  }

  if (record.revoked) {
    return false;
  }

  return identity.generation >= record.generation;
}

export function revokeSession(identity: SessionIdentity): void {
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);

  const key = sessionRecordKey(identity);
  const existing = records.get(key);

  records.set(key, {
    key,
    userId: identity.userId,
    generation: REVOKED_GENERATION,
    revoked: true,
    expiresAtMs: Math.max(existing?.expiresAtMs ?? 0, nowMs + REVOCATION_TTL_MS),
  });
}

export function revokeUserSessions(userId: string): number {
  const nowMs = Date.now();
  pruneExpiredSessions(nowMs);

  let revokedCount = 0;

  for (const record of records.values()) {
    if (record.userId !== userId || record.revoked) {
      continue;
    }
    record.generation = REVOKED_GENERATION;
    record.revoked = true;
    record.expiresAtMs = Math.max(record.expiresAtMs, nowMs + REVOCATION_TTL_MS);
    revokedCount += 1;
  }

  const legacyKey = sessionRecordKey({ userId });
  if (!records.has(legacyKey)) {
    records.set(legacyKey, {
      key: legacyKey,
      userId,
      generation: REVOKED_GENERATION,
      revoked: true,
      expiresAtMs: nowMs + REVOCATION_TTL_MS,
    });
    revokedCount += 1;
  }

  return revokedCount;
}

export function resetSessionStore(): void {
  records.clear();
  lastPrunedAtMs = 0;
}
