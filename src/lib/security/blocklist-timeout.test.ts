import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlocklistTimeoutError,
  DEFAULT_BLOCKLIST_TIMEOUT_MS,
  MAX_BLOCKLIST_TIMEOUT_MS,
  MIN_BLOCKLIST_TIMEOUT_MS,
  checkBlocklist,
  fetchBlocklist,
  getBlocklistHealth,
  getBlocklistTimeoutMs,
  getStaleBlocklist,
  isBlocklistTimeout,
  resetBlocklistCache,
} from "@/lib/security/blocklist";

const FEED = "https://example.com/blocklist.json";

/** A feed that never answers; like undici it rejects with the signal's reason once aborted. */
function hangingFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

/** A feed that sends its headers at once, then stalls the body until the signal aborts. */
function stallingBodyFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const signal = init?.signal as AbortSignal;
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  });
}

/** Warm the cache with `domains`, then make it expire so the next call must refresh. */
async function warmThenExpire(domains: string[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(domains), { status: 200 }));
  await fetchBlocklist();
  const later = Date.now() + 10 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(later);
  vi.mocked(globalThis.fetch).mockReset();
}

beforeEach(() => {
  process.env.FORTEXA_BLOCKLIST_URL = FEED;
  process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "100";
  resetBlocklistCache();
});

afterEach(() => {
  delete process.env.FORTEXA_BLOCKLIST_URL;
  delete process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS;
  resetBlocklistCache();
  vi.restoreAllMocks();
});

describe("getBlocklistTimeoutMs", () => {
  it("defaults to 5 seconds when unset, empty or blank", () => {
    delete process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS;
    expect(getBlocklistTimeoutMs()).toBe(DEFAULT_BLOCKLIST_TIMEOUT_MS);
    expect(DEFAULT_BLOCKLIST_TIMEOUT_MS).toBe(5000);
    for (const blank of ["", "   "]) {
      process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = blank;
      expect(getBlocklistTimeoutMs()).toBe(DEFAULT_BLOCKLIST_TIMEOUT_MS);
    }
  });

  it("reads a whole number of milliseconds, ignoring surrounding spaces", () => {
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "2500";
    expect(getBlocklistTimeoutMs()).toBe(2500);
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "  1500  ";
    expect(getBlocklistTimeoutMs()).toBe(1500);
  });

  it("raises a value below the floor and lowers one above the ceiling", () => {
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "0";
    expect(getBlocklistTimeoutMs()).toBe(MIN_BLOCKLIST_TIMEOUT_MS);
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "99";
    expect(getBlocklistTimeoutMs()).toBe(MIN_BLOCKLIST_TIMEOUT_MS);
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "999999999";
    expect(getBlocklistTimeoutMs()).toBe(MAX_BLOCKLIST_TIMEOUT_MS);
  });

  it("falls back to the default for anything that is not a whole number", () => {
    for (const bad of ["abc", "5s", "1e3", "-5", "2.5", "NaN", "Infinity", "0x10"]) {
      process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = bad;
      expect(getBlocklistTimeoutMs()).toBe(DEFAULT_BLOCKLIST_TIMEOUT_MS);
    }
  });
});

describe("fetchBlocklist timeout", () => {
  it("hands fetch an abort signal", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(["a.example"]), { status: 200 }));

    await fetchBlocklist();

    expect(fetchSpy).toHaveBeenCalledWith(FEED, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("gives up on a feed that never answers, within the configured time", async () => {
    hangingFetch();
    const started = performance.now();

    await expect(fetchBlocklist()).rejects.toBeInstanceOf(BlocklistTimeoutError);

    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(3000);
  });

  it("gives up on a body that stalls after the headers arrive", async () => {
    stallingBodyFetch();

    await expect(fetchBlocklist()).rejects.toBeInstanceOf(BlocklistTimeoutError);
  });

  it("reports the same words however the runtime words its abort", async () => {
    hangingFetch();
    await expect(fetchBlocklist()).rejects.toThrow("Blocklist fetch timed out after 100ms");
    expect(getBlocklistHealth().lastError).toBe("Blocklist fetch timed out after 100ms");

    resetBlocklistCache();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("aborted", "TimeoutError"));
    await expect(fetchBlocklist()).rejects.toThrow("Blocklist fetch timed out after 100ms");
  });

  it("carries the timeout that applied", async () => {
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "250";
    hangingFetch();

    const error = await fetchBlocklist().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BlocklistTimeoutError);
    expect((error as BlocklistTimeoutError).timeoutMs).toBe(250);
  });

  it("does not mistake other failures for a timeout", async () => {
    const boom = new Error("Network error");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(boom);
    await expect(fetchBlocklist()).rejects.toBe(boom);

    resetBlocklistCache();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 503 }));
    const error = await fetchBlocklist().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BlocklistTimeoutError);
    expect((error as Error).message).toBe("HTTP 503");
  });

  it("keeps the previous list when a refresh times out", async () => {
    await warmThenExpire(["bad.example", "worse.example"]);
    hangingFetch();

    await expect(fetchBlocklist()).rejects.toBeInstanceOf(BlocklistTimeoutError);

    expect(getStaleBlocklist()).toEqual(["bad.example", "worse.example"]);
    const health = getBlocklistHealth();
    expect(health.domainCount).toBe(2);
    expect(health.lastError).toBe("Blocklist fetch timed out after 100ms");
    expect(health.lastRefreshAt).toBeTruthy();
  });

  it("clears the error again once a later refresh succeeds", async () => {
    hangingFetch();
    await expect(fetchBlocklist()).rejects.toBeInstanceOf(BlocklistTimeoutError);
    expect(getBlocklistHealth().lastError).not.toBeNull();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(["ok.example"]), { status: 200 }));
    await expect(fetchBlocklist()).resolves.toEqual(["ok.example"]);

    expect(getBlocklistHealth().lastError).toBeNull();
  });
});

describe("isBlocklistTimeout", () => {
  it("recognises the aborts a timeout raises", () => {
    expect(isBlocklistTimeout(new BlocklistTimeoutError(100))).toBe(true);
    expect(isBlocklistTimeout(new DOMException("t", "TimeoutError"))).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isBlocklistTimeout(abort)).toBe(true);
  });

  it("does not claim other errors, whatever their wording", () => {
    expect(isBlocklistTimeout(new Error("Network timeout"))).toBe(false);
    expect(isBlocklistTimeout(new Error("HTTP 503"))).toBe(false);
    expect(isBlocklistTimeout("timeout")).toBe(false);
    expect(isBlocklistTimeout(null)).toBe(false);
  });
});

describe("getStaleBlocklist", () => {
  it("is empty before any successful fetch", () => {
    expect(getStaleBlocklist()).toEqual([]);
  });

  it("returns a copy, so callers cannot change the cache", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(["a.example"]), { status: 200 }));
    await fetchBlocklist();

    getStaleBlocklist().push("injected.example");

    expect(getStaleBlocklist()).toEqual(["a.example"]);
  });
});

describe("checkBlocklist when the refresh times out", () => {
  it("still denies a domain on the last good list", async () => {
    await warmThenExpire(["bad.example"]);
    hangingFetch();

    await expect(checkBlocklist("Bad.Example")).resolves.toEqual({
      allow: false,
      reasonCode: "BLOCKLIST_MATCH",
    });
  });

  it("allows a domain that was not on the last good list", async () => {
    await warmThenExpire(["bad.example"]);
    hangingFetch();

    await expect(checkBlocklist("good.example")).resolves.toEqual({ allow: true, reasonCode: null });
  });

  it("answers within the timeout when there is no list at all", async () => {
    hangingFetch();
    const started = performance.now();

    await expect(checkBlocklist("good.example")).resolves.toEqual({ allow: true, reasonCode: null });

    expect(performance.now() - started).toBeLessThan(3000);
  });
});
