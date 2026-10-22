import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBlocklist, fetchBlocklist, getBlocklistHealth, resetBlocklistCache } from "@/lib/security/blocklist";

describe("blocklist health", () => {
  beforeEach(() => {
    delete process.env.FORTEXA_BLOCKLIST_URL;
    resetBlocklistCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.FORTEXA_BLOCKLIST_URL;
    resetBlocklistCache();
  });

  it("reports unconfigured when FORTEXA_BLOCKLIST_URL is not set", () => {
    const health = getBlocklistHealth();
    expect(health.configured).toBe(false);
    expect(health.lastRefreshAt).toBeNull();
    expect(health.domainCount).toBe(0);
    expect(health.lastError).toBeNull();
  });

  it("reports configured with domain count and refresh timestamp after successful fetch", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad-actor.com", "scam.io"]), { status: 200 })
    );

    const domains = await fetchBlocklist();
    expect(domains).toEqual(["bad-actor.com", "scam.io"]);

    const health = getBlocklistHealth();
    expect(health.configured).toBe(true);
    expect(health.domainCount).toBe(2);
    expect(health.lastRefreshAt).toBeTruthy();
    expect(health.lastError).toBeNull();
  });

  it("reports last error summary after a failed fetch", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    await expect(fetchBlocklist()).rejects.toThrow("Network error");

    const health = getBlocklistHealth();
    expect(health.configured).toBe(true);
    expect(health.lastError).toBe("Network error");
    expect(health.domainCount).toBe(0);
  });

  it("reports stale cache and error when fetch fails after a prior success", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad-actor.com"]), { status: 200 })
    );
    await fetchBlocklist();

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Timeout"));

    await expect(fetchBlocklist()).rejects.toThrow("Timeout");

    const health = getBlocklistHealth();
    expect(health.configured).toBe(true);
    expect(health.lastError).toBe("Timeout");
    expect(health.domainCount).toBe(1);
    expect(health.lastRefreshAt).toBeTruthy();
  });

  it("returns empty array and reports error on HTTP error", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Service Unavailable", { status: 503 })
    );

    await expect(fetchBlocklist()).rejects.toThrow("HTTP 503");

    const health = getBlocklistHealth();
    expect(health.lastError).toBe("HTTP 503");
  });

  it("rejects a feed response larger than 1 MiB", async () => {
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
    );

    await expect(fetchBlocklist()).rejects.toThrow("Blocklist response exceeds 1048576 bytes");
    expect(getBlocklistHealth().domainCount).toBe(0);
  });
});

describe("checkBlocklist", () => {
  beforeEach(() => {
    resetBlocklistCache();
    process.env.FORTEXA_BLOCKLIST_URL = "https://example.com/blocklist.json";
  });

  afterEach(() => {
    delete process.env.FORTEXA_BLOCKLIST_URL;
    resetBlocklistCache();
    vi.restoreAllMocks();
  });

  it("allows a domain that is not listed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad.example"]), { status: 200 }),
    );
    await expect(checkBlocklist("good.example")).resolves.toEqual({ allow: true, reasonCode: null });
  });

  it("denies a listed domain with BLOCKLIST_MATCH", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad.example"]), { status: 200 }),
    );
    await expect(checkBlocklist("Bad.Example")).resolves.toEqual({
      allow: false,
      reasonCode: "BLOCKLIST_MATCH",
    });
  });

  it("does not throw when the feed is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("down"));
    await expect(checkBlocklist("good.example")).resolves.toEqual({ allow: true, reasonCode: null });
  });
});

describe("production blocklist URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.FORTEXA_BLOCKLIST_URL;
    resetBlocklistCache();
  });

  it("fetches an HTTPS blocklist URL in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FORTEXA_BLOCKLIST_URL", "https://blocklist.example.com/list.json");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad.example"]), { status: 200 })
    );

    await expect(fetchBlocklist()).resolves.toEqual(["bad.example"]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://blocklist.example.com/list.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(getBlocklistHealth().configured).toBe(true);
  });

  it.each([
    ["", "required in production"],
    ["   ", "required in production"],
    ["http://blocklist.example.com/list.json", "must use HTTPS"],
    ["not a url", "valid HTTPS URL"],
    ["https://", "valid HTTPS URL"],
  ])("rejects %j before fetch (%s)", async (blocklistUrl, message) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("FORTEXA_BLOCKLIST_URL", blocklistUrl);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fetchBlocklist()).rejects.toThrow(message);
    await expect(checkBlocklist("good.example")).rejects.toThrow(message);
    expect(() => getBlocklistHealth()).toThrow(message);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unset blocklist URL in production before fetch", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.FORTEXA_BLOCKLIST_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fetchBlocklist()).rejects.toThrow("required in production");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still allows an empty blocklist URL outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.FORTEXA_BLOCKLIST_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fetchBlocklist()).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getBlocklistHealth().configured).toBe(false);
  });
});
