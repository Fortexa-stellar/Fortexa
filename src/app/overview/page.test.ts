import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Health is stubbed through global fetch. Nothing here reaches the health
// route's dependencies, so Horizon is never called.

vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  CheckCircle2: () => null,
  CreditCard: () => null,
  Loader2: () => null,
  ShieldAlert: () => null,
  TrendingUp: () => null,
  Wallet: () => null,
}));

let stateIndex = 0;
let refIndex = 0;
const states: unknown[] = [];
const setters: Array<(value: unknown) => void> = [];
const refs: Array<{ current: unknown }> = [];
let effect: (() => void | (() => void)) | null = null;

vi.mock("react", async () => {
  const original = await vi.importActual<typeof import("react")>("react");
  return {
    ...original,
    useState: (initialValue: unknown) => {
      const index = stateIndex;
      stateIndex += 1;
      if (states.length <= index) {
        states.push(
          typeof initialValue === "function"
            ? (initialValue as () => unknown)()
            : initialValue
        );
        setters.push((next: unknown) => {
          states[index] =
            typeof next === "function"
              ? (next as (prev: unknown) => unknown)(states[index])
              : next;
        });
      }
      return [states[index], setters[index]];
    },
    useRef: (initialValue: unknown) => {
      const index = refIndex;
      refIndex += 1;
      if (refs.length <= index) {
        refs.push({ current: initialValue });
      }
      return refs[index];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: (callback: () => void | (() => void)) => {
      effect = callback;
    },
  };
});

import Link from "next/link";

import OverviewPage, {
  DEFAULT_OVERVIEW_TOTALS,
  OVERVIEW_PAYMENT_SHORTCUTS,
  OVERVIEW_READINESS_POLL_MS,
  readinessFromHealthBody,
  type OverviewPaymentTotalsData,
} from "./page";

type HealthBody = { ready: boolean; failingChecks: string[] };

type PendingHealth = {
  resolve: (body: HealthBody) => void;
  reject: (error: Error) => void;
};

const pending: PendingHealth[] = [];
const fetchMock = vi.fn((url: string) => {
  if (url !== "/api/health") {
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  }
  return new Promise<Response>((resolve, reject) => {
    pending.push({
      resolve: (body) =>
        resolve(
          new Response(JSON.stringify({ ok: true, ...body }), { status: 200 })
        ),
      reject,
    });
  });
});

const intervals: Array<() => void> = [];
const clearIntervalMock = vi.fn();

const READY: HealthBody = { ready: true, failingChecks: [] };
const NOT_READY: HealthBody = {
  ready: false,
  failingChecks: ["storage", "horizon"],
};

type Element = { type: unknown; props: Record<string, unknown> };

function isElement(node: unknown): node is Element {
  return (
    typeof node === "object" && node !== null && "props" in node && "type" in node
  );
}

let currentFixtureTotals: OverviewPaymentTotalsData | undefined = undefined;

function render(fixtureTotals?: OverviewPaymentTotalsData) {
  if (fixtureTotals !== undefined) {
    currentFixtureTotals = fixtureTotals;
  }
  stateIndex = 0;
  refIndex = 0;
  return OverviewPage({ fixtureTotals: currentFixtureTotals });
}

function walk(
  node: unknown,
  visit: (element: Element, parent: Element | null) => void,
  parent: Element | null = null
) {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit, parent));
    return;
  }
  if (!isElement(node)) {
    return;
  }
  visit(node, parent);

  if (typeof node.type === "function") {
    try {
      const rendered = (node.type as (props: Record<string, unknown>) => unknown)(
        node.props
      );
      walk(rendered, visit, node);
    } catch {
      // ignore
    }
  }

  walk(node.props.children, visit, node);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isElement(node)) return "";
  if (typeof node.type === "function") {
    try {
      const rendered = (node.type as (props: Record<string, unknown>) => unknown)(
        node.props
      );
      return textOf(rendered);
    } catch {
      // ignore
    }
  }
  return textOf(node.props.children);
}

function findElementByTestId(testId: string): Element | null {
  let found: Element | null = null;
  walk(render(), (element) => {
    if (element.props["data-testid"] === testId) {
      found = element;
    }
  });
  return found;
}

function failingChecksText(): string | null {
  const el = findElementByTestId("failing-checks");
  return el ? textOf(el.props.children) : null;
}

function isTotalsRendered(): boolean {
  return findElementByTestId("overview-totals") !== null;
}

function isShortcutsRendered(): boolean {
  return findElementByTestId("payment-shortcuts") !== null;
}

function renderedShortcutActions(): Map<string, { href: string | null }> {
  const shortcuts = new Map<string, { href: string | null }>();
  walk(render(), (element, parent) => {
    const id = element.props["data-action"];
    if (typeof id === "string") {
      shortcuts.set(id, {
        href: parent?.type === Link ? String(parent.props.href) : null,
      });
    }
  });
  return shortcuts;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mount(fixtureTotals?: OverviewPaymentTotalsData) {
  render(fixtureTotals);
  expect(effect).not.toBeNull();
  return effect!();
}

describe("OverviewPage readiness gate (#256)", () => {
  beforeEach(() => {
    currentFixtureTotals = undefined;
    states.length = 0;
    setters.length = 0;
    refs.length = 0;
    pending.length = 0;
    intervals.length = 0;
    effect = null;
    fetchMock.mockClear();
    clearIntervalMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      setInterval: (callback: () => void) => {
        intervals.push(callback);
        return intervals.length;
      },
      clearInterval: clearIntervalMock,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads readiness before rendering totals (initial checking state hides totals and shortcuts)", () => {
    mount();

    expect(fetchMock).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
    expect(isTotalsRendered()).toBe(false);
    expect(isShortcutsRendered()).toBe(false);
    expect(failingChecksText()).toBeNull();
  });

  it("ready health shows the fixture totals and payment shortcuts", async () => {
    const fixture: OverviewPaymentTotalsData = {
      totalPayments: "99",
      totalVolumeXLM: "4,500 XLM",
      settledPayments: "94",
      activeGuards: "16",
    };

    mount(fixture);
    pending[0].resolve(READY);
    await settle();

    expect(isTotalsRendered()).toBe(true);
    expect(isShortcutsRendered()).toBe(true);
    expect(failingChecksText()).toBeNull();

    // Verify rendered fixture totals
    const totalsEl = findElementByTestId("overview-totals");
    const totalsText = textOf(totalsEl);
    expect(totalsText).toContain("99");
    expect(totalsText).toContain("4,500 XLM");
    expect(totalsText).toContain("94");
    expect(totalsText).toContain("16");

    // Verify payment shortcuts
    const shortcuts = renderedShortcutActions();
    expect(shortcuts.get("pay")?.href).toBe("/console");
    expect(shortcuts.get("fund")?.href).toBe("/wallet");
    expect(shortcuts.get("run-evaluation")?.href).toBe("/console");
    expect(shortcuts.get("activate-policy")?.href).toBe("/policies");
  });

  it("ready health shows the default fixture totals when none are explicitly provided", async () => {
    mount();
    pending[0].resolve(READY);
    await settle();

    expect(isTotalsRendered()).toBe(true);
    const totalsText = textOf(findElementByTestId("overview-totals"));
    expect(totalsText).toContain(String(DEFAULT_OVERVIEW_TOTALS.totalPayments));
    expect(totalsText).toContain(String(DEFAULT_OVERVIEW_TOTALS.totalVolumeXLM));
  });

  it("not-ready health hides the totals and payment shortcuts and shows the failing check name", async () => {
    mount();
    pending[0].resolve(NOT_READY);
    await settle();

    expect(isTotalsRendered()).toBe(false);
    expect(isShortcutsRendered()).toBe(false);
    expect(failingChecksText()).toBe("Failing checks: storage, horizon");
  });

  it("a late not-ready response replaces an older ready view", async () => {
    mount();
    pending[0].resolve(READY);
    await settle();
    expect(isTotalsRendered()).toBe(true);
    expect(isShortcutsRendered()).toBe(true);

    // Next polling interval fires and health returns not ready
    intervals[0]();
    pending[1].resolve(NOT_READY);
    await settle();

    expect(isTotalsRendered()).toBe(false);
    expect(isShortcutsRendered()).toBe(false);
    expect(failingChecksText()).toBe("Failing checks: storage, horizon");
  });

  it("an older ready response does not override a newer not-ready response", async () => {
    mount(); // request 1 (older)
    intervals[0](); // request 2 (newer)
    expect(pending).toHaveLength(2);

    // The newer request answers first with NOT_READY
    pending[1].resolve(NOT_READY);
    await settle();
    expect(isTotalsRendered()).toBe(false);
    expect(isShortcutsRendered()).toBe(false);

    // The older request lands afterwards with READY. It must be dropped.
    pending[0].resolve(READY);
    await settle();

    expect(isTotalsRendered()).toBe(false);
    expect(isShortcutsRendered()).toBe(false);
    expect(failingChecksText()).toBe("Failing checks: storage, horizon");
  });

  it("drops an older not-ready response that lands after a newer ready response", async () => {
    mount();
    intervals[0]();

    pending[1].resolve(READY);
    await settle();
    pending[0].resolve(NOT_READY);
    await settle();

    expect(isTotalsRendered()).toBe(true);
    expect(isShortcutsRendered()).toBe(true);
  });

  it("hides totals and marks not-ready when health fetch rejects", async () => {
    mount();
    pending[0].reject(new TypeError("Network down"));
    await settle();

    expect(isTotalsRendered()).toBe(false);
    expect(isShortcutsRendered()).toBe(false);
    expect(failingChecksText()).toBe("Failing checks: health_unreachable");
  });

  it("cleans up intervals and drops in-flight responses on unmount", async () => {
    const cleanup = mount();
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(clearIntervalMock).toHaveBeenCalled();

    pending[0].resolve(READY);
    await settle();

    // The component state was not updated after unmount
    expect(states[0]).toEqual({ status: "checking" });
  });

  it("polls health at the defined interval and stubs health without reaching Horizon", async () => {
    mount();
    intervals[0]();
    intervals[0]();

    expect(intervals).toHaveLength(1);
    expect(OVERVIEW_READINESS_POLL_MS).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe("/api/health");
      expect(String(url)).not.toMatch(/horizon/i);
    }
  });
});

describe("readinessFromHealthBody helper", () => {
  it("treats only explicit ready: true as ready", () => {
    expect(readinessFromHealthBody({ ready: true, failingChecks: [] })).toEqual({
      status: "ready",
    });
    expect(readinessFromHealthBody({ ok: true })).toEqual({
      status: "not_ready",
      failingChecks: ["health_unavailable"],
    });
    expect(readinessFromHealthBody({ ready: "true" })).toEqual({
      status: "not_ready",
      failingChecks: ["health_unavailable"],
    });
    expect(readinessFromHealthBody(null)).toEqual({
      status: "not_ready",
      failingChecks: ["health_unavailable"],
    });
  });

  it("preserves failing check names from the health response body", () => {
    expect(
      readinessFromHealthBody({
        ready: false,
        failingChecks: ["production_config", "storage"],
      })
    ).toEqual({
      status: "not_ready",
      failingChecks: ["production_config", "storage"],
    });
  });
});
