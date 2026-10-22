import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import type { Pool } from "pg";

import { writeJsonFileAtomic } from "@/lib/storage/atomic-write";
import { runWithDatabase } from "@/lib/storage/db";
import { getFortexaStoreDir, getFortexaStorePath } from "@/lib/storage/paths";

/**
 * A record is `in_flight` from the moment a submit claims the idempotency key
 * until the submit settles. Only the owner of an `in_flight` record may submit,
 * which is what stops two identical requests from producing two payments.
 */
export type SubmitIdempotencyState = "in_flight" | "settled";

export type SubmitIdempotencyRecord = {
  userId: string;
  idempotencyKey: string;
  /** Canonical hash of (idempotency key + payment body). Identity of the request. */
  requestHash: string;
  state: SubmitIdempotencyState;
  /** Only meaningful while `state === "in_flight"`: when the claim goes stale. */
  leaseExpiresAt: string | null;
  /** Stored HTTP status of the original accepted result. */
  statusCode: number | null;
  /** Stored transaction id (Horizon hash) of the original accepted result. */
  transactionId: string | null;
  /** Stored response body of the original accepted result. */
  result: unknown;
  createdAt: string;
  updatedAt: string;
};

export type SubmitIdempotencyOutcome =
  /** This caller owns the key and must perform the submit. */
  | "claimed"
  /** The identical request already settled; return the stored result. */
  | "replay"
  /** An identical request is currently being submitted; do not submit again. */
  | "in_flight"
  /** The key was used with a different body; reject without building anything. */
  | "conflict";

export type SubmitIdempotencyResolution = {
  outcome: SubmitIdempotencyOutcome;
  record: SubmitIdempotencyRecord;
};

export type BeginIdempotentSubmitOptions = {
  /** How long to wait for a concurrent identical submit to settle. Default 5000ms. */
  inFlightWaitMs?: number;
  /** Polling cadence while waiting on a concurrent submit. Default 25ms. */
  pollIntervalMs?: number;
  /** How long a claim is honoured before another caller may take it over. Default 60s. */
  leaseMs?: number;
};

type IdempotencyStoreFile = {
  records: Record<string, SubmitIdempotencyRecord>;
};

type IdempotencyDbRow = {
  user_id: string;
  idempotency_key: string;
  request_hash: string | null;
  state: string | null;
  lease_expires_at: Date | string | null;
  status_code: number | null;
  transaction_id: string | null;
  result: unknown;
  created_at: Date | string;
  updated_at: Date | string | null;
};

const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_IN_FLIGHT_LEASE_MS = 60_000;
export const DEFAULT_IN_FLIGHT_WAIT_MS = 5_000;
const DEFAULT_IN_FLIGHT_POLL_INTERVAL_MS = 50;
const MAX_CLAIM_ATTEMPTS = 3;

const RECORD_COLUMNS = `
  user_id,
  idempotency_key,
  request_hash,
  state,
  lease_expires_at,
  status_code,
  transaction_id,
  result,
  created_at,
  updated_at
`;

const storePath = getFortexaStorePath("submit-idempotency.json");

/** Body fields that carry the key itself and must not take part in the body hash. */
const IDEMPOTENCY_KEY_FIELDS = new Set(["idempotencyKey", "idempotency_key"]);

export function hashSignedXdr(signedXdr: string) {
  return createHash("sha256").update(signedXdr).digest("hex");
}

/**
 * Stable serialization of an arbitrary JSON value: object keys are sorted and
 * `undefined` members are dropped, so two semantically identical bodies always
 * produce byte-identical output regardless of key order or extra `undefined`s.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      canonical[key] = canonicalize(source[key]);
    }

    return canonical;
  }

  return value;
}

function stripIdempotencyFields(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (IDEMPOTENCY_KEY_FIELDS.has(key)) continue;
    stripped[key] = value;
  }

  return stripped;
}

/**
 * Canonical form of a payment submission: the idempotency key plus a stable
 * serialization of the body with the key fields removed. The key is folded in
 * so a stored hash is bound to the key it was claimed under, and so a header
 * key and a body key for the same payment hash identically.
 */
export function canonicalPaymentRequest(idempotencyKey: string, payload: unknown): string {
  return JSON.stringify({
    idempotencyKey,
    body: canonicalize(stripIdempotencyFields(payload)),
  });
}

/** Identity fingerprint for "this exact request under this exact key". */
export function hashCanonicalPaymentBody(idempotencyKey: string, payload: unknown): string {
  return createHash("sha256")
    .update(canonicalPaymentRequest(idempotencyKey, payload))
    .digest("hex");
}

export function getIdempotencyRetentionDays(): number {
  const raw = process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

/** How long a retry waits for a concurrent identical submit before giving up. */
export function getIdempotencyInFlightWaitMs(): number {
  const raw = process.env.FORTEXA_IDEMPOTENCY_IN_FLIGHT_WAIT_MS?.trim();
  if (!raw) return DEFAULT_IN_FLIGHT_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IN_FLIGHT_WAIT_MS;
  return Math.floor(parsed);
}

function fileKey(userId: string, idempotencyKey: string) {
  return `${userId}:${idempotencyKey}`;
}

function toIso(
  value: Date | string | null | undefined,
  fallback: string | null = null
): string | null {
  if (value === null || value === undefined) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function isInFlightState(state: unknown): boolean {
  return state === "in_flight";
}

/**
 * A claim is only honoured while its lease is live. An expired lease means the
 * submitter died mid-flight, so the next caller may take the key over instead
 * of leaving it permanently unusable.
 */
function isLeaseExpired(record: SubmitIdempotencyRecord, nowMs: number): boolean {
  if (!isInFlightState(record.state)) return false;
  if (!record.leaseExpiresAt) return true;
  const expiry = new Date(record.leaseExpiresAt).getTime();
  return !Number.isFinite(expiry) || expiry <= nowMs;
}

/** Live claims are never expired by cleanup, even once past the retention window. */
function isProtectedInFlight(record: SubmitIdempotencyRecord, nowMs: number): boolean {
  return isInFlightState(record.state) && !isLeaseExpired(record, nowMs);
}

function classifyExisting(
  existing: SubmitIdempotencyRecord,
  requestHash: string
): Exclude<SubmitIdempotencyOutcome, "claimed"> {
  if (existing.requestHash !== requestHash) return "conflict";
  if (!isInFlightState(existing.state)) return "replay";
  return "in_flight";
}

function recordFromRow(row: IdempotencyDbRow): SubmitIdempotencyRecord {
  const createdAt = toIso(row.created_at, new Date().toISOString()) as string;

  return {
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash ?? "",
    state: isInFlightState(row.state) ? "in_flight" : "settled",
    leaseExpiresAt: toIso(row.lease_expires_at),
    statusCode: typeof row.status_code === "number" ? row.status_code : null,
    transactionId: row.transaction_id ?? null,
    result: row.result,
    createdAt,
    updatedAt: toIso(row.updated_at, createdAt) as string,
  };
}

/** Tolerates records written by older versions that predate the claim fields. */
function normalizeFileRecord(
  raw: unknown,
  userId: string,
  idempotencyKey: string
): SubmitIdempotencyRecord {
  const source = (raw ?? {}) as Partial<SubmitIdempotencyRecord> & { xdrHash?: string };
  const createdAt =
    typeof source.createdAt === "string" ? source.createdAt : new Date().toISOString();

  return {
    userId: typeof source.userId === "string" ? source.userId : userId,
    idempotencyKey:
      typeof source.idempotencyKey === "string" ? source.idempotencyKey : idempotencyKey,
    requestHash:
      typeof source.requestHash === "string" ? source.requestHash : (source.xdrHash ?? ""),
    state: isInFlightState(source.state) ? "in_flight" : "settled",
    leaseExpiresAt: typeof source.leaseExpiresAt === "string" ? source.leaseExpiresAt : null,
    statusCode: typeof source.statusCode === "number" ? source.statusCode : null,
    transactionId: typeof source.transactionId === "string" ? source.transactionId : null,
    result: source.result ?? null,
    createdAt,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : createdAt,
  };
}

async function ensureStore() {
  await fs.mkdir(getFortexaStoreDir(), { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    const initial: IdempotencyStoreFile = { records: {} };
    await writeJsonFileAtomic(storePath, initial);
  }
}

async function readStore(): Promise<IdempotencyStoreFile> {
  await ensureStore();
  const raw = await fs.readFile(storePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<IdempotencyStoreFile>;
  return { records: parsed?.records ?? {} };
}

async function writeStore(store: IdempotencyStoreFile) {
  await writeJsonFileAtomic(storePath, store);
}

/**
 * Serializes every file-store mutation so a concurrent claim cannot interleave a
 * read-modify-write with another one and lose the first record.
 */
let storeLock: Promise<void> = Promise.resolve();

async function withStoreLock<T>(action: () => Promise<T>): Promise<T> {
  const previous = storeLock;
  let release: () => void = () => undefined;
  storeLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => undefined);

  try {
    return await action();
  } finally {
    release();
  }
}

function newClaimRecord(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  leaseMs: number,
  nowMs = Date.now()
): SubmitIdempotencyRecord {
  return {
    userId,
    idempotencyKey,
    requestHash,
    state: "in_flight",
    leaseExpiresAt: new Date(nowMs + leaseMs).toISOString(),
    statusCode: null,
    transactionId: null,
    result: null,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function claimInFileStore(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  leaseMs: number
): Promise<SubmitIdempotencyResolution> {
  return withStoreLock(async () => {
    const store = await readStore();
    const key = fileKey(userId, idempotencyKey);
    const existingRaw = store.records[key];

    if (!existingRaw) {
      const record = newClaimRecord(userId, idempotencyKey, requestHash, leaseMs);
      store.records[key] = record;
      await writeStore(store);
      return { outcome: "claimed", record } satisfies SubmitIdempotencyResolution;
    }

    const existing = normalizeFileRecord(existingRaw, userId, idempotencyKey);
    store.records[key] = existing;

    const outcome = classifyExisting(existing, requestHash);
    if (outcome !== "in_flight" || !isLeaseExpired(existing, Date.now())) {
      return { outcome, record: existing };
    }

    const takenOver: SubmitIdempotencyRecord = {
      ...existing,
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.records[key] = takenOver;
    await writeStore(store);

    return { outcome: "claimed", record: takenOver } satisfies SubmitIdempotencyResolution;
  });
}

async function selectRecordFromDb(
  pool: Pool,
  userId: string,
  idempotencyKey: string
): Promise<SubmitIdempotencyRecord | null> {
  const result = await pool.query<IdempotencyDbRow>(
    `SELECT ${RECORD_COLUMNS}
     FROM fortexa_submit_idempotency
     WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey]
  );

  const row = result.rows[0];
  return row ? recordFromRow(row) : null;
}

async function claimInDatabase(
  pool: Pool,
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  leaseMs: number
): Promise<SubmitIdempotencyResolution> {
  let lastKnown: SubmitIdempotencyRecord | null = null;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const nowIso = new Date().toISOString();
    const leaseIso = new Date(Date.now() + leaseMs).toISOString();

    // First write wins: a concurrent duplicate cannot overwrite the original claim.
    const inserted = await pool.query<IdempotencyDbRow>(
      `INSERT INTO fortexa_submit_idempotency
         (user_id, idempotency_key, xdr_hash, request_hash, state, lease_expires_at,
          status_code, transaction_id, result, created_at, updated_at)
       VALUES ($1, $2, $3, $3, 'in_flight', $4::timestamptz, NULL, NULL, '{}'::jsonb,
               $5::timestamptz, $5::timestamptz)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING ${RECORD_COLUMNS}`,
      [userId, idempotencyKey, requestHash, leaseIso, nowIso]
    );

    const claimedRow = inserted.rows[0];
    if (claimedRow) {
      return { outcome: "claimed", record: recordFromRow(claimedRow) };
    }

    const existing = await selectRecordFromDb(pool, userId, idempotencyKey);
    if (!existing) {
      // The conflicting row was deleted between INSERT and SELECT; retry.
      continue;
    }

    lastKnown = existing;

    const outcome = classifyExisting(existing, requestHash);
    if (outcome !== "in_flight" || !isLeaseExpired(existing, Date.now())) {
      return { outcome, record: existing };
    }

    const takenOver = await pool.query<IdempotencyDbRow>(
      `UPDATE fortexa_submit_idempotency
          SET lease_expires_at = $4::timestamptz,
              updated_at = $5::timestamptz
        WHERE user_id = $1
          AND idempotency_key = $2
          AND request_hash = $3
          AND state = 'in_flight'
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
        RETURNING ${RECORD_COLUMNS}`,
      [userId, idempotencyKey, requestHash, leaseIso, nowIso]
    );

    const takeoverRow = takenOver.rows[0];
    if (takeoverRow) {
      return { outcome: "claimed", record: recordFromRow(takeoverRow) };
    }
  }

  // Never resolved into a claim: fail closed rather than risk a second payment.
  return {
    outcome: "in_flight",
    record: lastKnown ?? newClaimRecord(userId, idempotencyKey, requestHash, leaseMs),
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export async function getIdempotencyRecord(
  userId: string,
  idempotencyKey: string
): Promise<SubmitIdempotencyRecord | null> {
  const db = await runWithDatabase("getIdempotencyRecord", (pool) =>
    selectRecordFromDb(pool, userId, idempotencyKey)
  );

  if (db.available) {
    return db.value;
  }

  const store = await withStoreLock(readStore);
  const raw = store.records[fileKey(userId, idempotencyKey)];
  return raw ? normalizeFileRecord(raw, userId, idempotencyKey) : null;
}

export async function getAllIdempotencyRecords(): Promise<SubmitIdempotencyRecord[]> {
  const db = await runWithDatabase("getAllIdempotencyRecords", async (pool) => {
    const result = await pool.query<{
      user_id: string;
      idempotency_key: string;
      xdr_hash: string;
      result: unknown;
      created_at: string;
    }>(
      `
        SELECT user_id, idempotency_key, xdr_hash, result, created_at
        FROM fortexa_submit_idempotency
      `
    );

    return result.rows.map((row) => ({
      userId: row.user_id,
      idempotencyKey: row.idempotency_key,
      xdrHash: row.xdr_hash,
      result: row.result,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  });

  if (db.available) {
    return db.value;
  }

  const store = await readStore();
  return Object.values(store.records);
}

export async function putIdempotencyRecord(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  options: BeginIdempotentSubmitOptions = {}
): Promise<SubmitIdempotencyResolution> {
  const leaseMs = options.leaseMs ?? DEFAULT_IN_FLIGHT_LEASE_MS;
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_IN_FLIGHT_POLL_INTERVAL_MS);
  const waitMs = Math.max(0, options.inFlightWaitMs ?? DEFAULT_IN_FLIGHT_WAIT_MS);
  const deadline = Date.now() + waitMs;

  // Once the database proves unavailable, stop re-probing it on every poll: a
  // broken database must not turn a wait into a burst of fallback warnings.
  let useDatabase = true;

  for (;;) {
    let resolution: SubmitIdempotencyResolution;

    if (useDatabase) {
      const db = await runWithDatabase("beginIdempotentSubmit", (pool) =>
        claimInDatabase(pool, userId, idempotencyKey, requestHash, leaseMs)
      );

      if (db.available) {
        resolution = db.value;
      } else {
        useDatabase = false;
        resolution = await claimInFileStore(userId, idempotencyKey, requestHash, leaseMs);
      }
    } else {
      resolution = await claimInFileStore(userId, idempotencyKey, requestHash, leaseMs);
    }

    if (resolution.outcome !== "in_flight") {
      return resolution;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return resolution;
    }

    await delay(Math.min(pollIntervalMs, remaining));
  }
}

/**
 * Stores the accepted result for a key this caller claimed. First write wins, so
 * a lost race can never replace the original transaction id or status.
 */
export async function completeIdempotentSubmit(
  userId: string,
  idempotencyKey: string,
  requestHash: string,
  payload: { statusCode: number; transactionId: string | null; result: unknown }
): Promise<SubmitIdempotencyRecord> {
  const nowIso = new Date().toISOString();

  const db = await runWithDatabase("completeIdempotentSubmit", async (pool) => {
    const updated = await pool.query<IdempotencyDbRow>(
      `UPDATE fortexa_submit_idempotency
          SET state = 'settled',
              status_code = $4,
              transaction_id = $5,
              result = $6::jsonb,
              lease_expires_at = NULL,
              updated_at = $7::timestamptz
        WHERE user_id = $1
          AND idempotency_key = $2
          AND request_hash = $3
          AND state = 'in_flight'
        RETURNING ${RECORD_COLUMNS}`,
      [
        userId,
        idempotencyKey,
        requestHash,
        payload.statusCode,
        payload.transactionId,
        JSON.stringify(payload.result ?? null),
        nowIso,
      ]
    );

    const settledRow = updated.rows[0];
    if (settledRow) {
      return recordFromRow(settledRow);
    }

    const existing = await selectRecordFromDb(pool, userId, idempotencyKey);
    if (existing) {
      // Already settled under this key: the original result always wins.
      return existing;
    }

    // The claim was removed between claim and settle; persist the accepted
    // outcome so a later retry still replays it instead of submitting again.
    const inserted = await pool.query<IdempotencyDbRow>(
      `INSERT INTO fortexa_submit_idempotency
         (user_id, idempotency_key, xdr_hash, request_hash, state, lease_expires_at,
          status_code, transaction_id, result, created_at, updated_at)
       VALUES ($1, $2, $3, $3, 'settled', NULL, $4, $5, $6::jsonb,
               $7::timestamptz, $7::timestamptz)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING ${RECORD_COLUMNS}`,
      [
        userId,
        idempotencyKey,
        requestHash,
        payload.statusCode,
        payload.transactionId,
        JSON.stringify(payload.result ?? null),
        nowIso,
      ]
    );

    const reInsertedRow = inserted.rows[0];
    if (reInsertedRow) {
      return recordFromRow(reInsertedRow);
    }

    return (
      (await selectRecordFromDb(pool, userId, idempotencyKey)) ?? {
        ...newClaimRecord(userId, idempotencyKey, requestHash, 0),
        state: "settled" as const,
        leaseExpiresAt: null,
        statusCode: payload.statusCode,
        transactionId: payload.transactionId,
        result: payload.result ?? null,
        updatedAt: nowIso,
      }
    );
  });

  if (db.available) {
    return db.value;
  }

  return withStoreLock(async () => {
    const store = await readStore();
    const key = fileKey(userId, idempotencyKey);
    const existingRaw = store.records[key];
    const existing = existingRaw ? normalizeFileRecord(existingRaw, userId, idempotencyKey) : null;

    if (existing && (existing.requestHash !== requestHash || existing.state !== "in_flight")) {
      // Different body, or the original result is already stored: first write wins.
      return existing;
    }

    const record: SubmitIdempotencyRecord = {
      userId,
      idempotencyKey,
      requestHash,
      state: "settled",
      leaseExpiresAt: null,
      statusCode: payload.statusCode,
      transactionId: payload.transactionId,
      result: payload.result ?? null,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };

    store.records[key] = record;
    await writeStore(store);

    return record;
  });
}

/**
 * Releases a claimed key after a failed submit so the client can retry. Scoped
 * to the request hash and to still-in-flight records, so it can never delete a
 * settled result or a concurrent claim for a different body.
 */
export async function abortIdempotentSubmit(
  userId: string,
  idempotencyKey: string,
  requestHash: string
): Promise<boolean> {
  const db = await runWithDatabase("abortIdempotentSubmit", async (pool) => {
    const deleted = await pool.query(
      `DELETE FROM fortexa_submit_idempotency
        WHERE user_id = $1
          AND idempotency_key = $2
          AND request_hash = $3
          AND state = 'in_flight'`,
      [userId, idempotencyKey, requestHash]
    );

    return (deleted.rowCount ?? 0) > 0;
  });

  if (db.available) {
    return db.value;
  }

  return withStoreLock(async () => {
    const store = await readStore();
    const key = fileKey(userId, idempotencyKey);
    const existingRaw = store.records[key];

    if (!existingRaw) {
      return false;
    }

    const existing = normalizeFileRecord(existingRaw, userId, idempotencyKey);
    if (existing.requestHash !== requestHash || !isInFlightState(existing.state)) {
      return false;
    }

    delete store.records[key];
    await writeStore(store);
    return true;
  });
}

export async function resetSubmitIdempotencyState(userId: string) {
  const db = await runWithDatabase("resetSubmitIdempotencyState", async (pool) => {
    await pool.query(`DELETE FROM fortexa_submit_idempotency WHERE user_id = $1`, [userId]);
    return true;
  });

  if (db.available) {
    return;
  }

  await withStoreLock(async () => {
    const store = await readStore();
    let mutated = false;
    for (const key of Object.keys(store.records)) {
      if (store.records[key].userId === userId) {
        delete store.records[key];
        mutated = true;
      }
    }

    if (mutated) {
      await writeStore(store);
    }
  });
}

export async function cleanupOldIdempotencyRecords(retentionDays?: number): Promise<number> {
  const days = retentionDays ?? getIdempotencyRetentionDays();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const db = await runWithDatabase("cleanupOldIdempotencyRecords", async (pool) => {
    // A live in-flight claim is never dropped: the submit owning it may still be
    // about to settle, and deleting it would reopen the key for a second payment.
    const result = await pool.query(
      `DELETE FROM fortexa_submit_idempotency
        WHERE created_at < $1::timestamptz
          AND created_at::date != CURRENT_DATE
          AND (
            state <> 'in_flight'
            OR lease_expires_at IS NULL
            OR lease_expires_at <= NOW()
          )`,
      [cutoff.toISOString()]
    );
    return result.rowCount ?? 0;
  });

  if (db.available) {
    return db.value;
  }

  return withStoreLock(async () => {
    const store = await readStore();
    const today = new Date().toISOString().slice(0, 10);
    const nowMs = Date.now();
    let deletedCount = 0;
    let mutated = false;

    for (const [key, raw] of Object.entries(store.records)) {
      const record = normalizeFileRecord(raw, "", "");
      const recordDate = new Date(record.createdAt);

      if (isProtectedInFlight(record, nowMs)) {
        continue;
      }

      if (recordDate < cutoff && record.createdAt.slice(0, 10) !== today) {
        delete store.records[key];
        deletedCount++;
        mutated = true;
      }
    }

    if (mutated) {
      await writeStore(store);
    }

    return deletedCount;
  });
}

let lastCleanupTime = 0;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export function getLastCleanupTime(): number {
  return lastCleanupTime;
}

/** Reset the last cleanup time (used in tests). */
export function __resetLastCleanupTime() {
  lastCleanupTime = 0;
}

export function maybeRunCleanup(): void {
  const now = Date.now();
  if (now - lastCleanupTime < CLEANUP_INTERVAL_MS) return;
  lastCleanupTime = now;

  cleanupOldIdempotencyRecords().catch(() => {
    // Cleanup is best-effort; failures should not affect the request.
  });
}
