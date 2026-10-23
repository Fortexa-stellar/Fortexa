import { promises as fs } from "node:fs";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmpDir = `/tmp/fortexa-idem-store-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.FORTEXA_STORE_DIR = tmpDir;
  process.env.FORTEXA_AUTH_SECRET = "idem-store-test-secret";
  delete process.env.DATABASE_URL;
  delete process.env.FORTEXA_IDEMPOTENCY_RETENTION_DAYS;
});

import {
  abortIdempotentSubmit,
  beginIdempotentSubmit,
  canonicalPaymentRequest,
  completeIdempotentSubmit,
  getIdempotencyRecord,
  hashCanonicalPaymentBody,
  hashSignedXdr,
  resetSubmitIdempotencyState,
} from "@/lib/storage/submit-idempotency-store";

const USER_ID = "idem-store-user";
const OTHER_USER_ID = "idem-store-other-user";
const KEY = "idem-store-key-0001";
const NO_WAIT = { inFlightWaitMs: 0 } as const;

const DESTINATION_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const DESTINATION_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

afterAll(async () => {
  const storeDir = process.env.FORTEXA_STORE_DIR;
  if (storeDir && storeDir.startsWith("/tmp/fortexa-idem-store-")) {
    await fs.rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

beforeEach(async () => {
  await resetSubmitIdempotencyState(USER_ID);
  await resetSubmitIdempotencyState(OTHER_USER_ID);
});

describe("hashCanonicalPaymentBody", () => {
  it("is stable regardless of key order in the body", () => {
    const a = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR", amountXLM: "1.0" });
    const b = hashCanonicalPaymentBody(KEY, { amountXLM: "1.0", signedXdr: "XDR" });

    expect(a).toBe(b);
  });

  it("ignores undefined members", () => {
    const withUndefined = hashCanonicalPaymentBody(KEY, {
      signedXdr: "XDR",
      memo: undefined,
    });
    const withoutMember = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    expect(withUndefined).toBe(withoutMember);
  });

  it("treats the same payment sent as a header key or a body key identically", () => {
    const viaHeader = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });
    const viaBody = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR", idempotencyKey: KEY });

    expect(viaBody).toBe(viaHeader);
  });

  it("changes when the payment body changes", () => {
    const toA = hashCanonicalPaymentBody(KEY, {
      signedXdr: "XDR",
      destination: DESTINATION_A,
    });
    const toB = hashCanonicalPaymentBody(KEY, {
      signedXdr: "XDR",
      destination: DESTINATION_B,
    });

    expect(toA).not.toBe(toB);
  });

  it("changes when the idempotency key changes", () => {
    const first = hashCanonicalPaymentBody("idem-store-key-0001", { signedXdr: "XDR" });
    const second = hashCanonicalPaymentBody("idem-store-key-0002", { signedXdr: "XDR" });

    expect(first).not.toBe(second);
  });

  it("is not the raw signed-XDR hash", () => {
    expect(hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" })).not.toBe(hashSignedXdr("XDR"));
  });

  it("exposes a stable canonical serialization with the key folded in", () => {
    expect(canonicalPaymentRequest(KEY, { signedXdr: "XDR", idempotencyKey: KEY })).toBe(
      canonicalPaymentRequest(KEY, { signedXdr: "XDR" })
    );
    expect(canonicalPaymentRequest(KEY, { signedXdr: "XDR" })).toBe(
      `{"idempotencyKey":"${KEY}","body":{"signedXdr":"XDR"}}`
    );
  });

  it("drops the body key field so it cannot shadow the resolved key", () => {
    const canonical = canonicalPaymentRequest(KEY, { signedXdr: "XDR", idempotency_key: "other" });

    expect(canonical).not.toContain("other");
    expect(canonical).toBe(`{"idempotencyKey":"${KEY}","body":{"signedXdr":"XDR"}}`);
  });
});

describe("beginIdempotentSubmit", () => {
  it("claims an unused key for the first caller", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });
    const claim = await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);

    expect(claim.outcome).toBe("claimed");
    expect(claim.record.state).toBe("in_flight");
    expect(claim.record.requestHash).toBe(requestHash);
    expect(claim.record.leaseExpiresAt).not.toBeNull();
  });

  it("grants the claim to exactly one of many concurrent callers", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT))
    );

    expect(claims.filter((claim) => claim.outcome === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === "in_flight")).toHaveLength(4);
  });

  it("replays the stored status and transaction id once the claim settles", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });
    const result = { ok: true, transactionHash: "abc" };

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    await completeIdempotentSubmit(USER_ID, KEY, requestHash, {
      statusCode: 200,
      transactionId: "abc",
      result,
    });

    const replay = await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    expect(replay.outcome).toBe("replay");
    expect(replay.record.statusCode).toBe(200);
    expect(replay.record.transactionId).toBe("abc");
    expect(replay.record.result).toEqual(result);
    expect(replay.record.state).toBe("settled");
    expect(replay.record.leaseExpiresAt).toBeNull();
  });

  it("conflicts when the same key is reused with a different body", async () => {
    const firstHash = hashCanonicalPaymentBody(KEY, {
      signedXdr: "XDR",
      destination: DESTINATION_A,
    });
    const secondHash = hashCanonicalPaymentBody(KEY, {
      signedXdr: "XDR",
      destination: DESTINATION_B,
    });

    await beginIdempotentSubmit(USER_ID, KEY, firstHash, NO_WAIT);
    await completeIdempotentSubmit(USER_ID, KEY, firstHash, {
      statusCode: 200,
      transactionId: "abc",
      result: { ok: true },
    });

    const conflict = await beginIdempotentSubmit(USER_ID, KEY, secondHash, NO_WAIT);
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.record.requestHash).toBe(firstHash);
    expect(conflict.record.transactionId).toBe("abc");
  });

  it("conflicts while the original request is still in flight", async () => {
    const firstHash = hashCanonicalPaymentBody(KEY, {
      signedXdr: "XDR",
      destination: DESTINATION_A,
    });
    const secondHash = hashCanonicalPaymentBody(KEY, {
      signedXdr: "XDR",
      destination: DESTINATION_B,
    });

    await beginIdempotentSubmit(USER_ID, KEY, firstHash, NO_WAIT);

    const conflict = await beginIdempotentSubmit(USER_ID, KEY, secondHash, NO_WAIT);
    expect(conflict.outcome).toBe("conflict");
  });

  it("scopes keys per user", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    await completeIdempotentSubmit(USER_ID, KEY, requestHash, {
      statusCode: 200,
      transactionId: "abc",
      result: { ok: true },
    });

    const otherUser = await beginIdempotentSubmit(OTHER_USER_ID, KEY, requestHash, NO_WAIT);
    expect(otherUser.outcome).toBe("claimed");
  });

  it("waits for a concurrent identical submit and replays its result", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    const owner = await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    expect(owner.outcome).toBe("claimed");

    setTimeout(() => {
      void completeIdempotentSubmit(USER_ID, KEY, requestHash, {
        statusCode: 200,
        transactionId: "abc",
        result: { ok: true },
      });
    }, 30);

    const retried = await beginIdempotentSubmit(USER_ID, KEY, requestHash, {
      inFlightWaitMs: 2_000,
      pollIntervalMs: 5,
    });

    expect(retried.outcome).toBe("replay");
    expect(retried.record.transactionId).toBe("abc");
  });

  it("returns in_flight when the concurrent submit does not settle in time", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);

    const retried = await beginIdempotentSubmit(USER_ID, KEY, requestHash, {
      inFlightWaitMs: 40,
      pollIntervalMs: 5,
    });

    expect(retried.outcome).toBe("in_flight");
  });

  it("lets a later caller take over a claim whose lease expired", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    const owner = await beginIdempotentSubmit(USER_ID, KEY, requestHash, {
      inFlightWaitMs: 0,
      leaseMs: 1,
    });
    expect(owner.outcome).toBe("claimed");

    await new Promise((resolve) => setTimeout(resolve, 15));

    const takeover = await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    expect(takeover.outcome).toBe("claimed");
    expect(takeover.record.createdAt).toBe(owner.record.createdAt);
  });
});

describe("completeIdempotentSubmit", () => {
  it("keeps the first settled result when a duplicate completes late", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    await completeIdempotentSubmit(USER_ID, KEY, requestHash, {
      statusCode: 200,
      transactionId: "first",
      result: { ok: true, transactionHash: "first" },
    });
    await completeIdempotentSubmit(USER_ID, KEY, requestHash, {
      statusCode: 200,
      transactionId: "second",
      result: { ok: true, transactionHash: "second" },
    });

    const stored = await getIdempotencyRecord(USER_ID, KEY);
    expect(stored?.transactionId).toBe("first");
  });

  it("never overwrites a record claimed under a different body", async () => {
    const firstHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR-A" });
    const secondHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR-B" });

    await beginIdempotentSubmit(USER_ID, KEY, firstHash, NO_WAIT);
    await completeIdempotentSubmit(USER_ID, KEY, firstHash, {
      statusCode: 200,
      transactionId: "first",
      result: { ok: true },
    });

    const late = await completeIdempotentSubmit(USER_ID, KEY, secondHash, {
      statusCode: 200,
      transactionId: "second",
      result: { ok: true },
    });

    expect(late.transactionId).toBe("first");
    const stored = await getIdempotencyRecord(USER_ID, KEY);
    expect(stored?.transactionId).toBe("first");
  });
});

describe("abortIdempotentSubmit", () => {
  it("frees a failed claim so the key can be reused", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    expect(await abortIdempotentSubmit(USER_ID, KEY, requestHash)).toBe(true);
    expect(await getIdempotencyRecord(USER_ID, KEY)).toBeNull();

    const retry = await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    expect(retry.outcome).toBe("claimed");
  });

  it("does not release a settled record", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    await completeIdempotentSubmit(USER_ID, KEY, requestHash, {
      statusCode: 200,
      transactionId: "abc",
      result: { ok: true },
    });

    expect(await abortIdempotentSubmit(USER_ID, KEY, requestHash)).toBe(false);
    expect(await getIdempotencyRecord(USER_ID, KEY)).not.toBeNull();
  });

  it("does not release another body's claim", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });
    const otherHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR-OTHER" });

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);

    expect(await abortIdempotentSubmit(USER_ID, KEY, otherHash)).toBe(false);
    expect((await getIdempotencyRecord(USER_ID, KEY))?.state).toBe("in_flight");
  });
});

describe("getIdempotencyRecord", () => {
  afterEach(async () => {
    await resetSubmitIdempotencyState(USER_ID);
  });

  it("returns null for an unknown key", async () => {
    expect(await getIdempotencyRecord(USER_ID, "never-used-key")).toBeNull();
  });

  it("returns the stored record for a known key", async () => {
    const requestHash = hashCanonicalPaymentBody(KEY, { signedXdr: "XDR" });

    await beginIdempotentSubmit(USER_ID, KEY, requestHash, NO_WAIT);
    await completeIdempotentSubmit(USER_ID, KEY, requestHash, {
      statusCode: 200,
      transactionId: "abc",
      result: { ok: true },
    });

    const stored = await getIdempotencyRecord(USER_ID, KEY);
    expect(stored).toMatchObject({
      userId: USER_ID,
      idempotencyKey: KEY,
      requestHash,
      state: "settled",
      statusCode: 200,
      transactionId: "abc",
    });
  });
});
