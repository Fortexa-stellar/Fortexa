import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Health is stubbed through global fetch. Nothing here reaches the health
// route's dependencies, so Horizon is never called.

vi.mock("lucide-react", () => ({
  ArrowRight: () => null,
  Loader2: () => null,
  ShieldAlert: () => null,
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
          typeof initialValue === "function" ? (initialValue as () => unknown)() : initialValue
        );
        setters.push((next: unknown) => {
          states[index] =
            typeof next === "function" ? (next as (prev: unknown) => unknown)(states[index]) : next;
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

import {
  DASHBOARD_ACTIONS,
  DashboardActions,
  READINESS_POLL_MS,
  readinessFromHealthBody,
} from "./dashboard-actions";

type HealthBody = { ready: boolean; failingChecks: string[] };

type PendingHealth = { resolve: (body: HealthBody) => void; reject: (error: Error) => void };

const pending: PendingHealth[] = [];
const fetchMock = vi.fn((url: string) => {
  if (url !== "/api/health") {
    return Promise.reject(new Error(`Unexpected fetch: ${url}`));
  }
  return new Promise<Response>((resolve, reject) => {
    pending.push({
      resolve: (body) =>
        resolve(new Response(JSON.stringify({ ok: true, ...body }), { status: 200 })),
      reject,
    });
  });
});

const intervals: Array<() => void> = [];
const clearIntervalMock = vi.fn();

const READY: HealthBody = { ready: true, failingChecks: [] };
const NOT_READY: HealthBody = { ready: false, failingChecks: ["storage", "horizon"] };

type Element = { type: unknown; props: Record<string, unknown> };

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "props" in node && "type" in node;
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
  walk(node.props.children, visit, node);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isElement(node) ? textOf(node.props.children) : "";
}

function render() {
  stateIndex = 0;
  refIndex = 0;
  return DashboardActions();
}

type RenderedAction = { enabled: boolean; href: string | null };

function renderedActions() {
  const actions = new Map<string, RenderedAction>();
  walk(render(), (element, parent) => {
    const id = element.props["data-action"];
    if (typeof id === "string") {
      actions.set(id, {
        enabled: element.props.disabled !== true,
        href: parent?.type === Link ? String(parent.props.href) : null,
      });
    }
  });
  return actions;
}

function failingChecksText() {
  let text: string | null = null;
  walk(render(), (element) => {
    if (element.props["data-testid"] === "failing-checks") {
      text = textOf(element.props.children);
    }
  });
  return text;
}

function expectAllActions(expected: "enabled" | "disabled") {
  const actions = renderedActions();
  expect([...actions.keys()].sort()).toEqual(DASHBOARD_ACTIONS.map((action) => action.id).sort());
  for (const [id, action] of actions) {
    if (expected === "enabled") {
      expect(action, id).toEqual({
        enabled: true,
        href: DASHBOARD_ACTIONS.find((a) => a.id === id)!.href,
      });
    } else {
      expect(action, id).toEqual({ enabled: false, href: null });
    }
  }
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function mount() {
  render();
  expect(effect).not.toBeNull();
  return effect!();
}

describe("DashboardActions readiness gate", () => {
  beforeEach(() => {
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

  it("keeps every action disabled until the first health response arrives", () => {
    mount();

    expect(fetchMock).toHaveBeenCalledWith("/api/health", { cache: "no-store" });
    expectAllActions("disabled");
    expect(failingChecksText()).toBeNull();
  });

  it("shows pay, fund, and policy activation when health reports ready", async () => {
    mount();
    pending[0].resolve(READY);
    await settle();

    expectAllActions("enabled");
    expect(renderedActions().get("pay")?.href).toBe("/console");
    expect(renderedActions().get("fund")?.href).toBe("/wallet");
    expect(renderedActions().get("activate-policy")?.href).toBe("/policies");
    expect(failingChecksText()).toBeNull();
  });

  it("disables pay, fund, and policy activation and names the failing checks when not ready", async () => {
    mount();
    pending[0].resolve(NOT_READY);
    await settle();

    expectAllActions("disabled");
    expect(failingChecksText()).toBe("Failing checks: storage, horizon");
  });

  it("hides actions an earlier ready response showed when a later poll reports not ready", async () => {
    mount();
    pending[0].resolve(READY);
    await settle();
    expectAllActions("enabled");

    intervals[0]();
    pending[1].resolve(NOT_READY);
    await settle();

    expectAllActions("disabled");
    expect(failingChecksText()).toBe("Failing checks: storage, horizon");
  });

  it("does not let an older ready response override a newer not-ready response", async () => {
    mount(); // request 1 (older)
    intervals[0](); // request 2 (newer)
    expect(pending).toHaveLength(2);

    // The newer request answers first with not ready...
    pending[1].resolve(NOT_READY);
    await settle();
    expectAllActions("disabled");

    // ...then the older one finally arrives with ready. It must be dropped.
    pending[0].resolve(READY);
    await settle();

    expectAllActions("disabled");
    expect(failingChecksText()).toBe("Failing checks: storage, horizon");
  });

  it("drops an older not-ready response that lands after a newer ready one", async () => {
    mount();
    intervals[0]();

    pending[1].resolve(READY);
    await settle();
    pending[0].resolve(NOT_READY);
    await settle();

    expectAllActions("enabled");
  });

  it("stays gated when the health route cannot be reached", async () => {
    mount();
    pending[0].reject(new TypeError("Failed to fetch"));
    await settle();

    expectAllActions("disabled");
    expect(failingChecksText()).toBe("Failing checks: health_unreachable");
  });

  it("ignores a response that arrives after unmount", async () => {
    const cleanup = mount();
    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(clearIntervalMock).toHaveBeenCalled();

    pending[0].resolve(READY);
    await settle();

    expect(states[0]).toEqual({ status: "checking" });
  });

  it("polls health on the configured interval and only ever calls the health route", async () => {
    mount();
    intervals[0]();
    intervals[0]();

    expect(intervals).toHaveLength(1);
    expect(READINESS_POLL_MS).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe("/api/health");
      expect(String(url)).not.toMatch(/horizon/i);
    }
  });
});

describe("readinessFromHealthBody", () => {
  it("treats only an explicit ready: true as ready", () => {
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

  it("keeps the failing check names from the health body", () => {
    expect(
      readinessFromHealthBody({ ready: false, failingChecks: ["production_config", 7] })
    ).toEqual({
      status: "not_ready",
      failingChecks: ["production_config"],
    });
  });
});
