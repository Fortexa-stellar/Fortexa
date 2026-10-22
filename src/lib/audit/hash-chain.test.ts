import { describe, expect, it } from "vitest";

import { GENESIS_HASH, computeEntryHash, verifyHashChain } from "@/lib/audit/hash-chain";
import type { AuditEntry } from "@/lib/types/domain";

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: "entry-1",
    timestamp: "2024-01-01T00:00:00.000Z",
    action: {
      id: "action-1",
      name: "pay",
      kind: "api_payment",
      target: "GDEST",
      domain: "stellar.org",
      amountXLM: 10,
    },
    decision: "APPROVE",
    explanation: "Within policy limits",
    triggeredPolicies: [],
    riskFindings: [],
    ...overrides,
  };
}

function buildChain(count: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let previousHash = GENESIS_HASH;

  for (let i = 0; i < count; i++) {
    const base = makeEntry({
      id: `entry-${i + 1}`,
      timestamp: `2024-01-01T00:0${i}:00.000Z`,
    });
    const entryHash = computeEntryHash({ ...base, previousHash });
    entries.push({ ...base, previousHash, entryHash });
    previousHash = entryHash;
  }

  return entries;
}

describe("computeEntryHash", () => {
  it("produces a 64-character hex string", () => {
    const entry = makeEntry();
    const hash = computeEntryHash({ ...entry, previousHash: GENESIS_HASH });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same inputs yield the same hash", () => {
    const entry = makeEntry();
    const h1 = computeEntryHash({ ...entry, previousHash: GENESIS_HASH });
    const h2 = computeEntryHash({ ...entry, previousHash: GENESIS_HASH });
    expect(h1).toBe(h2);
  });

  it("is sensitive to field changes — different explanation yields different hash", () => {
    const entry = makeEntry();
    const h1 = computeEntryHash({ ...entry, previousHash: GENESIS_HASH });
    const h2 = computeEntryHash({
      ...entry,
      explanation: "modified explanation",
      previousHash: GENESIS_HASH,
    });
    expect(h1).not.toBe(h2);
  });

  it("is sensitive to previousHash changes", () => {
    const entry = makeEntry();
    const h1 = computeEntryHash({ ...entry, previousHash: GENESIS_HASH });
    const h2 = computeEntryHash({ ...entry, previousHash: "a".repeat(64) });
    expect(h1).not.toBe(h2);
  });

  it("produces identical hashes regardless of action key insertion order", () => {
    const base = makeEntry();
    const actionABOrder = { ...base.action };
    const actionBAOrder = {
      domain: base.action.domain,
      amountXLM: base.action.amountXLM,
      id: base.action.id,
      kind: base.action.kind,
      name: base.action.name,
      target: base.action.target,
    };

    const h1 = computeEntryHash({ ...base, action: actionABOrder, previousHash: GENESIS_HASH });
    const h2 = computeEntryHash({
      ...base,
      action: actionBAOrder as typeof base.action,
      previousHash: GENESIS_HASH,
    });
    expect(h1).toBe(h2);
  });

  it("first-entry previousHash is GENESIS_HASH (all zeros)", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    const entry = makeEntry();
    const hash = computeEntryHash({ ...entry, previousHash: GENESIS_HASH });
    expect(hash).toHaveLength(64);
  });
});

describe("verifyHashChain — valid chain", () => {
  it("returns valid for an empty entry list", () => {
    const result = verifyHashChain([]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.checkedCount).toBe(0);
      expect(result.legacyCount).toBe(0);
    }
  });

  it("returns valid for a single correctly hashed entry", () => {
    const [entry] = buildChain(1);
    const result = verifyHashChain([entry!]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.checkedCount).toBe(1);
    }
  });

  it("returns valid for a multi-entry chain in any input order", () => {
    const chain = buildChain(5);
    // Pass entries in reverse order — verifyHashChain must sort internally.
    const result = verifyHashChain([...chain].reverse());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.checkedCount).toBe(5);
    }
  });

  it("reports legacyCount for entries without hash fields", () => {
    const legacy = makeEntry({ id: "legacy-1", timestamp: "2023-12-31T00:00:00.000Z" });
    const [hashed] = buildChain(1);
    const result = verifyHashChain([legacy, hashed!]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.legacyCount).toBe(1);
      expect(result.checkedCount).toBe(1);
    }
  });
});

describe("verifyHashChain — modified entry", () => {
  it("detects a tampered field in the middle of the chain", () => {
    const chain = buildChain(3);
    // Mutate the explanation of the second entry without updating its hash.
    const tampered = chain.map((e, idx) => (idx === 1 ? { ...e, explanation: "tampered!" } : e));
    const result = verifyHashChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("entryHash mismatch");
      expect(result.entryId).toBe("entry-2");
    }
  });

  it("detects a tampered decision field", () => {
    const chain = buildChain(2);
    const tampered = chain.map((e, idx) => (idx === 0 ? { ...e, decision: "BLOCK" as const } : e));
    const result = verifyHashChain(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("entryHash mismatch");
    }
  });
});

describe("verifyHashChain — deleted entry", () => {
  it("detects a removed entry by previousHash mismatch", () => {
    const chain = buildChain(3);
    // Remove entry-2 (index 1) — now entry-3's previousHash points to entry-2 which is gone.
    const withGap = [chain[0]!, chain[2]!];
    const result = verifyHashChain(withGap);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("previousHash mismatch");
    }
  });

  it("detects removal of the first entry when the second entry previousHash is not GENESIS_HASH", () => {
    const chain = buildChain(3);
    const withoutFirst = chain.slice(1);
    const result = verifyHashChain(withoutFirst);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("previousHash mismatch");
    }
  });
});

describe("verifyHashChain — reordered entries", () => {
  it("detects entries whose timestamps have been swapped to disguise reordering", () => {
    const chain = buildChain(3);
    // Swap the timestamps of entry-2 and entry-3 so sort puts them in the wrong order
    // but the hash chain still reflects the original creation order.
    const swapped = [
      chain[0]!,
      { ...chain[1]!, timestamp: chain[2]!.timestamp },
      { ...chain[2]!, timestamp: chain[1]!.timestamp },
    ];
    const result = verifyHashChain(swapped);
    // After sorting by the swapped timestamps, entry-3 (with entry-2's ts) comes before
    // entry-2 (with entry-3's ts). The previousHash of entry-3 points to entry-2, which
    // is not the previous hashed entry after swapping, so verification fails.
    expect(result.valid).toBe(false);
  });
});

describe("verifyHashChain — legacy entries handled gracefully", () => {
  it("passes when all entries are legacy (no hash fields)", () => {
    const entries = [
      makeEntry({ id: "l1", timestamp: "2023-01-01T00:00:00.000Z" }),
      makeEntry({ id: "l2", timestamp: "2023-01-02T00:00:00.000Z" }),
    ];
    const result = verifyHashChain(entries);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.legacyCount).toBe(2);
      expect(result.checkedCount).toBe(0);
    }
  });

  it("verifies new hashed entries that follow legacy entries", () => {
    const legacyA = makeEntry({ id: "legacy-a", timestamp: "2023-01-01T00:00:00.000Z" });
    const legacyB = makeEntry({ id: "legacy-b", timestamp: "2023-01-02T00:00:00.000Z" });

    // First hashed entry starts its chain from GENESIS_HASH
    const base = makeEntry({ id: "hashed-1", timestamp: "2024-01-01T00:00:00.000Z" });
    const entryHash = computeEntryHash({ ...base, previousHash: GENESIS_HASH });
    const hashed = { ...base, previousHash: GENESIS_HASH, entryHash };

    const result = verifyHashChain([legacyA, legacyB, hashed]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.legacyCount).toBe(2);
      expect(result.checkedCount).toBe(1);
    }
  });
});
