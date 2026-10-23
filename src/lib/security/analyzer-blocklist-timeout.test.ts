import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultAnalyzerConfig,
  evaluateSecurity,
  getAnalyzerConfig,
} from "@/lib/security/analyzer";
import { fetchBlocklist, resetBlocklistCache } from "@/lib/security/blocklist";
import type { AgentAction } from "@/lib/types/domain";

const FEED = "https://example.com/blocklist.json";

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "timeout-1",
    name: "test action",
    kind: "api_payment",
    target: "alice",
    domain: "trusted.com",
    amountXLM: 10,
    ...overrides,
  };
}

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

describe("analyzer configuration", () => {
  it("defaults the blocklist timeout to 5 seconds", () => {
    delete process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS;
    expect(defaultAnalyzerConfig.blocklistTimeoutMs).toBe(5000);
    expect(getAnalyzerConfig().blocklistTimeoutMs).toBe(5000);
  });

  it("follows FORTEXA_BLOCKLIST_TIMEOUT_MS", () => {
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "750";
    expect(getAnalyzerConfig().blocklistTimeoutMs).toBe(750);
  });
});

describe("evaluateSecurity when the blocklist feed hangs", () => {
  it("resolves within the timeout and reports a degraded, timed-out check", async () => {
    hangingFetch();
    const started = performance.now();

    const result = await evaluateSecurity(makeAction());

    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.analyzerStatus).toMatchObject({
      blocklistStatus: "error",
      blocklistTimedOut: true,
      blocklistError: "Blocklist fetch timed out after 100ms",
      isDegraded: true,
    });
    expect(result.analyzerStatus.degradationReasons).toEqual(["blocklist_timeout_100ms"]);
  });

  it("names the timeout that applied in the degradation reason", async () => {
    process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS = "250";
    hangingFetch();

    const result = await evaluateSecurity(makeAction());

    expect(result.analyzerStatus.degradationReasons).toEqual(["blocklist_timeout_250ms"]);
  });

  it("falls back to no blocklist findings when there is no earlier list", async () => {
    hangingFetch();

    const result = await evaluateSecurity(makeAction());

    expect(result.findings).toHaveLength(0);
    expect(result.riskScore).toBe(10);
  });

  it("still runs every local check", async () => {
    hangingFetch();

    const result = await evaluateSecurity(
      makeAction({ domain: "evil-payments.com", outputPreview: "share your private key" }),
    );

    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain("SECRET_TARGETING");
    expect(codes).toContain("DOMAIN_REPUTATION_HIGH_RISK");
    expect(result.analyzerStatus.blocklistTimedOut).toBe(true);
  });

  it("falls back to the last good list, so a known-bad domain is still flagged", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad-actor.com"]), { status: 200 }),
    );
    await fetchBlocklist();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
    vi.mocked(globalThis.fetch).mockReset();
    hangingFetch();

    const result = await evaluateSecurity(makeAction({ domain: "bad-actor.com" }));

    expect(result.findings.map((f) => f.code)).toContain("BLOCKLIST_MATCH");
    expect(result.analyzerStatus.isDegraded).toBe(true);
    expect(result.analyzerStatus.blocklistTimedOut).toBe(true);
  });

  it("does not flag a domain the last good list did not contain", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad-actor.com"]), { status: 200 }),
    );
    await fetchBlocklist();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60 * 1000);
    vi.mocked(globalThis.fetch).mockReset();
    hangingFetch();

    const result = await evaluateSecurity(makeAction({ domain: "trusted.com" }));

    expect(result.findings.map((f) => f.code)).not.toContain("BLOCKLIST_MATCH");
  });
});

describe("evaluateSecurity: timeout versus other failures", () => {
  it("reports the default timeout when the runtime raises a timeout abort", async () => {
    delete process.env.FORTEXA_BLOCKLIST_TIMEOUT_MS;
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new DOMException("slow", "TimeoutError"));

    const result = await evaluateSecurity(makeAction());

    expect(result.analyzerStatus.blocklistTimedOut).toBe(true);
    expect(result.analyzerStatus.degradationReasons).toEqual(["blocklist_timeout_5000ms"]);
  });

  it("does not call an ordinary failure a timeout, whatever its message says", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network timeout"));

    const result = await evaluateSecurity(makeAction());

    expect(result.analyzerStatus.blocklistStatus).toBe("error");
    expect(result.analyzerStatus.blocklistTimedOut).toBeUndefined();
    expect(result.analyzerStatus.degradationReasons).toEqual(["blocklist_fetch_failed"]);
    expect(result.analyzerStatus.isDegraded).toBe(true);
  });

  it("is not degraded when the feed answers in time", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(["bad-actor.com"]), { status: 200 }),
    );

    const result = await evaluateSecurity(makeAction());

    expect(result.analyzerStatus).toMatchObject({
      blocklistStatus: "success",
      isDegraded: false,
      degradationReasons: [],
    });
    expect(result.analyzerStatus.blocklistTimedOut).toBeUndefined();
  });

  it("is not degraded, and does not fetch, when no feed is configured", async () => {
    delete process.env.FORTEXA_BLOCKLIST_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await evaluateSecurity(makeAction());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.analyzerStatus.isDegraded).toBe(false);
  });
});
