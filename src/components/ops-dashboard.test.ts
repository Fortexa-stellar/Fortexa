import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";

// Mock global.fetch
const fetchMock = vi.fn();
global.fetch = fetchMock;

// Mock window/global interval/clear
const mockIntervals: Array<{ fn: () => void; delay: number }> = [];
const mockClearInterval = vi.fn();
const mockSetInterval = vi.fn().mockImplementation((fn: () => void, delay: number) => {
  mockIntervals.push({ fn, delay });
  return mockIntervals.length;
});

vi.stubGlobal("setInterval", mockSetInterval);
vi.stubGlobal("clearInterval", mockClearInterval);
vi.stubGlobal("window", {
  setInterval: (fn: () => void, delay: number) => mockSetInterval(fn, delay),
  clearInterval: (id: number) => mockClearInterval(id),
});

// Mock lucide-react to avoid importing SVG logic
vi.mock("lucide-react", () => {
  return {
    AlertTriangle: () => null,
    CheckCircle2: () => null,
    Clock3: () => null,
    Database: () => null,
    HelpCircle: () => null,
    Shield: () => null,
    ShieldAlert: () => null,
    ShieldCheck: () => null,
    ShieldOff: () => null,
  };
});

// Mock recharts
vi.mock("recharts", () => {
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
    LineChart: ({ children }: { children: React.ReactNode }) => children,
    Line: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
  };
});

// Setup mock state storage
let hookIndex = 0;
const states: unknown[] = [];
const setters: Array<(val: unknown) => void> = [];
let mockEffectCb: (() => void) | null = null;

// Mock React
vi.mock("react", async () => {
  const original = await vi.importActual<typeof import("react")>("react");
  return {
    ...original,
    useState: (initialValue: unknown) => {
      const currentIndex = hookIndex;
      hookIndex++;
      if (states.length <= currentIndex) {
        const value =
          typeof initialValue === "function" ? (initialValue as () => unknown)() : initialValue;
        states.push(value);
        setters.push((newValue: unknown) => {
          if (typeof newValue === "function") {
            states[currentIndex] = newValue(states[currentIndex]);
          } else {
            states[currentIndex] = newValue;
          }
        });
      }
      return [states[currentIndex], setters[currentIndex]];
    },
    useEffect: (effect: () => void) => {
      mockEffectCb = effect;
    },
    useMemo: (factory: () => unknown) => {
      return factory();
    },
  };
});

// Import component AFTER mocking React and other dependencies
import { OpsDashboard } from "./ops-dashboard";

async function flushPromises() {
  await vi.advanceTimersByTimeAsync(50);
}

type HealthState = {
  ok: boolean;
  timestamp: string;
  env: Record<string, boolean>;
  blocklist: Record<string, unknown>;
} | null;
type MetricsState = {
  totals: { totalCount: number; errorCount: number; errorRate: number };
  routes: unknown[];
} | null;

describe("OpsDashboard lastRefreshed feature", () => {
  beforeEach(() => {
    hookIndex = 0;
    states.length = 0;
    setters.length = 0;
    mockIntervals.length = 0;
    mockEffectCb = null;
    fetchMock.mockReset();
    mockSetInterval.mockClear();
    mockClearInterval.mockClear();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T23:56:21.000Z"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const getHealth = () => states[0] as HealthState;
  const getMetrics = () => states[1] as MetricsState;
  const getTxCount = () => states[3] as number | null;
  const getError = () => states[5] as string | null;
  const getLoading = () => states[6] as boolean;
  const getTxLoading = () => states[7] as boolean;
  const getLastRefreshed = () => states[8] as string | null;

  function setupSuccessfulFetch() {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/health")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              service: "fortexa",
              timestamp: "2026-06-29T23:56:21Z",
              env: { hasGroqKey: true, hasAuthSecret: true, hasHorizonUrl: true },
              blocklist: {
                configured: true,
                lastRefreshAt: "2026-06-29T23:00:00Z",
                domainCount: 42,
                lastError: null,
              },
            }),
        });
      }
      if (url.includes("/api/metrics")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              service: "fortexa",
              timestamp: "2026-06-29T23:56:21Z",
              totals: { totalCount: 10, errorCount: 0, errorRate: 0 },
              routes: [],
            }),
        });
      }
      if (url.includes("/api/audit/export")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              scope: "all",
              exportedBy: "admin",
              entriesByUser: {
                user1: [{ stellarTxHash: "tx1" }],
              },
            }),
        });
      }
      return Promise.reject(new Error("Not found"));
    });
  }

  function setupFailedFetch() {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/health") || url.includes("/api/metrics")) {
        return Promise.resolve({
          ok: false,
          status: 500,
        });
      }
      return Promise.reject(new Error("Internal Server Error"));
    });
  }

  it("should start with no timestamp before the first successful refresh", () => {
    setupSuccessfulFetch();

    hookIndex = 0;
    OpsDashboard({});

    expect(getLastRefreshed()).toBeNull();
  });

  it("should display the last refreshed timestamp after a successful refresh", async () => {
    setupSuccessfulFetch();

    hookIndex = 0;
    OpsDashboard({});

    // Trigger the effect callback
    expect(mockEffectCb).not.toBeNull();
    mockEffectCb!();

    // Wait for the async loadCore to complete
    await flushPromises();

    expect(getLoading()).toBe(false);
    expect(getError()).toBeNull();
    expect(getLastRefreshed()).toBe("2026-06-29T23:56:21.000Z");
    expect(getHealth()).not.toBeNull();
    expect(getHealth()!.ok).toBe(true);
    expect(getMetrics()).not.toBeNull();
    expect(getMetrics()!.totals.totalCount).toBe(10);
  });

  it("should update the last refreshed timestamp after another successful refresh", async () => {
    setupSuccessfulFetch();

    hookIndex = 0;
    OpsDashboard({});

    expect(mockEffectCb).not.toBeNull();
    mockEffectCb!();

    await flushPromises();
    expect(getLastRefreshed()).toBe("2026-06-29T23:56:21.000Z");

    // Advance time and trigger interval refresh
    vi.setSystemTime(new Date("2026-06-29T23:56:30.000Z"));
    expect(mockIntervals.length).toBe(1);

    // Call the interval refresh callback
    mockIntervals[0].fn();

    await flushPromises();

    expect(getLastRefreshed()).toBe("2026-06-29T23:56:30.000Z");
    expect(getError()).toBeNull();
  });

  it("should not update the timestamp if a refresh fails", async () => {
    setupSuccessfulFetch();

    hookIndex = 0;
    OpsDashboard({});

    expect(mockEffectCb).not.toBeNull();
    mockEffectCb!();

    await flushPromises();
    expect(getLastRefreshed()).toBe("2026-06-29T23:56:21.000Z");

    // Setup failed fetch for next refresh
    setupFailedFetch();

    // Advance time and trigger interval refresh
    vi.setSystemTime(new Date("2026-06-29T23:56:45.000Z"));
    expect(mockIntervals.length).toBe(1);
    mockIntervals[0].fn();

    await flushPromises();

    // Timestamp should remain unchanged
    expect(getLastRefreshed()).toBe("2026-06-29T23:56:21.000Z");
    expect(getError()).toBe("Failed to fetch ops telemetry.");
  });

  it("should keep existing dashboard behavior unchanged", async () => {
    setupSuccessfulFetch();

    hookIndex = 0;
    OpsDashboard({});

    expect(mockEffectCb).not.toBeNull();
    mockEffectCb!();

    await flushPromises();

    expect(getHealth()).not.toBeNull();
    expect(getHealth()!.ok).toBe(true);
    expect(getMetrics()).not.toBeNull();
    expect(getMetrics()!.totals.totalCount).toBe(10);
    expect(getTxCount()).toBe(1);
    expect(getTxLoading()).toBe(false);
  });
});
