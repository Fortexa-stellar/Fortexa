import { promises as fs } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmpDir = `/tmp/fortexa-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.FORTEXA_STORE_DIR = tmpDir;
  process.env.FORTEXA_AUTH_SECRET = "cleanup-test-secret";
  delete process.env.DATABASE_URL;
  delete process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS;
});

import { getFortexaStorePath } from "@/lib/storage/paths";
import {
  beginIdempotentSubmit,
  cleanupOldIdempotencyRecords,
  getIdempotencyRecord,
  getIdempotencyRetentionDays,
  resetSubmitIdempotencyState,
} from "@/lib/storage/submit-idempotency-store";

const TEST_USER = "cleanup-test-user";
const storePath = getFortexaStorePath("submit-idempotency.json");
const TEST_REQUEST_HASH = "a".repeat(64);

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function msFromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

type RecordInput = {
  idempotencyKey: string;
  createdAt: string;
  state?: "in_flight" | "settled";
  leaseExpiresAt?: string | null;
};

async function writeRecords(records: RecordInput[]) {
  const store: { records: Record<string, unknown> } = { records: {} };
  for (const r of records) {
    const key = `${TEST_USER}:${r.idempotencyKey}`;
    store.records[key] = {
      userId: TEST_USER,
      idempotencyKey: r.idempotencyKey,
      requestHash: TEST_REQUEST_HASH,
      state: r.state ?? "settled",
      leaseExpiresAt: r.leaseExpiresAt ?? null,
      statusCode: 200,
      transactionId: "c".repeat(64),
      result: { ok: true },
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
    };
  }
  await fs.mkdir(process.env.FORTEXA_STORE_DIR!, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

async function readRecordKeys(): Promise<string[]> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const store = JSON.parse(raw);
    return Object.keys(store.records).filter((k) => k.startsWith(`${TEST_USER}:`));
  } catch {
    return [];
  }
}

async function readRecordCount(): Promise<number> {
  return (await readRecordKeys()).length;
}

beforeAll(async () => {
  await resetSubmitIdempotencyState(TEST_USER);
});

afterAll(async () => {
  const storeDir = process.env.FORTEXA_STORE_DIR;
  if (storeDir && storeDir.startsWith("/tmp/fortexa-cleanup-")) {
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("getIdempotencyRetentionDays", () => {
  it("defaults to 7 when env var is not set", () => {
    expect(getIdempotencyRetentionDays()).toBe(7);
  });

  it("reads FORTEXA_IDEMPOTENCY_RETENTION_DAYS when set", () => {
    process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS = "14";
    expect(getIdempotencyRetentionDays()).toBe(14);
    delete process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS;
  });

  it("rejects invalid values and falls back to default", () => {
    process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS = "invalid";
    expect(getIdempotencyRetentionDays()).toBe(7);
    process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS = "0";
    expect(getIdempotencyRetentionDays()).toBe(7);
    process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS = "-1";
    expect(getIdempotencyRetentionDays()).toBe(7);
    delete process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS;
  });
});

describe("cleanupOldIdempotencyRecords (file store)", () => {
  beforeEach(async () => {
    await resetSubmitIdempotencyState(TEST_USER);
  });

  it("deletes records older than the retention period", async () => {
    await writeRecords([
      { idempotencyKey: "old-key-1", createdAt: daysAgo(10) },
      { idempotencyKey: "old-key-2", createdAt: daysAgo(30) },
      { idempotencyKey: "recent-key", createdAt: daysAgo(1) },
    ]);

    const deleted = await cleanupOldIdempotencyRecords(7);
    expect(deleted).toBe(2);
    expect(await readRecordCount()).toBe(1);
  });

  it("preserves records within the retention window", async () => {
    await writeRecords([
      { idempotencyKey: "recent-1", createdAt: daysAgo(1) },
      { idempotencyKey: "recent-2", createdAt: daysAgo(3) },
      { idempotencyKey: "borderline", createdAt: daysAgo(6) },
    ]);

    const deleted = await cleanupOldIdempotencyRecords(7);
    expect(deleted).toBe(0);
    expect(await readRecordCount()).toBe(3);
  });

  it("does not delete same-day records even if retention is 0", async () => {
    const now = new Date().toISOString();

    await writeRecords([
      { idempotencyKey: "today-key", createdAt: now },
      { idempotencyKey: "old-key", createdAt: daysAgo(10) },
    ]);

    const deleted = await cleanupOldIdempotencyRecords(0);
    expect(deleted).toBe(1);
    expect(await readRecordCount()).toBe(1);
  });

  it("returns 0 when there are no records to clean", async () => {
    await writeRecords([{ idempotencyKey: "fresh-key", createdAt: daysAgo(1) }]);

    const deleted = await cleanupOldIdempotencyRecords(7);
    expect(deleted).toBe(0);
  });

  it("returns 0 when the store is empty", async () => {
    await writeRecords([]);

    const deleted = await cleanupOldIdempotencyRecords(7);
    expect(deleted).toBe(0);
  });

  it("honors a custom retentionDays argument", async () => {
    await writeRecords([
      { idempotencyKey: "mid-key", createdAt: daysAgo(5) },
      { idempotencyKey: "old-key", createdAt: daysAgo(15) },
    ]);

    const deleted = await cleanupOldIdempotencyRecords(10);
    expect(deleted).toBe(1);
    expect(await readRecordCount()).toBe(1);
  });
});

describe("cleanupOldIdempotencyRecords (in-flight protection)", () => {
  beforeEach(async () => {
    await resetSubmitIdempotencyState(TEST_USER);
  });

  it("does not delete a record that is still in flight, however old it is", async () => {
    await writeRecords([
      {
        idempotencyKey: "in-flight-key",
        createdAt: daysAgo(30),
        state: "in_flight",
        leaseExpiresAt: msFromNow(30_000),
      },
      { idempotencyKey: "settled-old-key", createdAt: daysAgo(30) },
    ]);

    const deleted = await cleanupOldIdempotencyRecords(7);
    expect(deleted).toBe(1);
    expect(await readRecordKeys()).toEqual([`${TEST_USER}:in-flight-key`]);
  });

  it("deletes an in-flight record whose claim lease has expired", async () => {
    await writeRecords([
      {
        idempotencyKey: "stuck-in-flight-key",
        createdAt: daysAgo(30),
        state: "in_flight",
        leaseExpiresAt: msFromNow(-1_000),
      },
    ]);

    const deleted = await cleanupOldIdempotencyRecords(7);
    expect(deleted).toBe(1);
    expect(await readRecordCount()).toBe(0);
  });

  it("keeps a freshly claimed in-flight record during a normal cleanup run", async () => {
    const claim = await beginIdempotentSubmit(TEST_USER, "live-claim-key", TEST_REQUEST_HASH, {
      inFlightWaitMs: 0,
    });
    expect(claim.outcome).toBe("claimed");

    const deleted = await cleanupOldIdempotencyRecords(7);
    expect(deleted).toBe(0);

    const stored = await getIdempotencyRecord(TEST_USER, "live-claim-key");
    expect(stored?.state).toBe("in_flight");
  });
});
