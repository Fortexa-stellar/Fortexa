import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global.fetch — no browser wallet involved anywhere in this suite.
const fetchMock = vi.fn();
global.fetch = fetchMock;

// Mock heavy leaf dependencies (icons, UI kit, import/export panel).
vi.mock("lucide-react", () => ({ History: () => null }));

vi.mock("@/components/ui/alert", () => ({
  Alert: (props: Record<string, unknown>) => ({ type: "Alert", props }),
  AlertTitle: (props: Record<string, unknown>) => ({ type: "AlertTitle", props }),
  AlertDescription: (props: Record<string, unknown>) => ({ type: "AlertDescription", props }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => ({ type: "Button", props }),
}));

vi.mock("@/components/ui/card", () => ({
  Card: (props: Record<string, unknown>) => ({ type: "Card", props }),
  CardHeader: (props: Record<string, unknown>) => ({ type: "CardHeader", props }),
  CardTitle: (props: Record<string, unknown>) => ({ type: "CardTitle", props }),
  CardDescription: (props: Record<string, unknown>) => ({ type: "CardDescription", props }),
  CardContent: (props: Record<string, unknown>) => ({ type: "CardContent", props }),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => ({ type: "Input", props }),
}));

vi.mock("@/components/policy-import-export", () => ({
  PolicyImportExport: () => null,
}));

// Session stub: operator role, no wallet, no session loading.
vi.mock("@/lib/auth/use-auth-session", () => ({
  useAuthSession: () => ({ loading: false, sessionLoading: false, isOperator: true }),
}));

// Mock React state so the component can be driven without a DOM.
let hookIndex = 0;
const states: unknown[] = [];
const setters: Array<(value: unknown) => void> = [];
let mockEffectCb: (() => void) | null = null;

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
            states[currentIndex] = (newValue as (prev: unknown) => unknown)(states[currentIndex]);
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
    useCallback: (fn: unknown) => fn,
  };
});

import { PolicyEditor } from "./policy-editor";
import type { PolicyValidationGate } from "@/lib/policy/activation";
import type { PolicyConfig } from "@/lib/types/domain";

const POLICY: PolicyConfig = {
  allowedDomains: ["api.example.com"],
  blockedDomains: ["malicious.com"],
  allowedTools: ["research-pro"],
  blockedTools: ["shadow-shell"],
  perTxCapXLM: 150,
  dailyCapXLM: 300,
  maxToolCallsPerDay: 10,
  riskThreshold: 80,
  allowedHours: { start: 6, end: 23 },
};

type MockResponse = { ok: boolean; status: number; body: unknown };
type FetchInit = { method?: string; body?: string };

function setupFetch(options: { validate?: MockResponse; policyPost?: MockResponse }) {
  fetchMock.mockImplementation(async (url: string, init?: FetchInit) => {
    const method = init?.method ?? "GET";

    if (url === "/api/policy/validate" && method === "POST") {
      const response = options.validate ?? { ok: false, status: 400, body: {} };
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      };
    }

    if (url === "/api/policy" && method === "POST") {
      const response = options.policyPost ?? { ok: false, status: 400, body: {} };
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      };
    }

    if (url === "/api/policy") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ policy: POLICY, updatedAt: "2026-09-30T00:00:00.000Z", version: 1 }),
      };
    }

    if (url.startsWith("/api/policy/history")) {
      return { ok: true, status: 200, json: async () => ({ entries: [] }) };
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

async function flush() {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

type Tree = { props?: Record<string, unknown> };

function renderEditor() {
  hookIndex = 0;
  return PolicyEditor() as unknown as Tree;
}

function findByTestId(node: unknown, testId: string): Tree | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByTestId(child, testId);
      if (hit) return hit;
    }
    return undefined;
  }
  if (node && typeof node === "object" && "props" in (node as Tree)) {
    const tree = node as Tree;
    if (tree.props?.["data-testid"] === testId) return tree;
    return findByTestId(tree.props?.children, testId);
  }
  return undefined;
}

function click(tree: Tree | undefined) {
  expect(tree).toBeDefined();
  const onClick = tree!.props!.onClick as () => void;
  onClick();
}

function treeText(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join("");
  if (node && typeof node === "object" && "props" in (node as Tree)) {
    return treeText((node as Tree).props?.children);
  }
  return "";
}

function policyPostCalls(): Array<{ url: string; init: FetchInit }> {
  return fetchMock.mock.calls
    .filter(
      ([url, init]) => url === "/api/policy" && (init as FetchInit | undefined)?.method === "POST"
    )
    .map(([url, init]) => ({ url: url as string, init: init as FetchInit }));
}

// State slot indices for PolicyEditor's useState sequence (documented order).
const STATUS_INDEX = 8;
const VALIDATION_GATE_INDEX = 21;

const getStatus = () => states[STATUS_INDEX] as string;
const getGate = () => states[VALIDATION_GATE_INDEX] as PolicyValidationGate;

describe("PolicyEditor activation gate", () => {
  beforeEach(() => {
    hookIndex = 0;
    states.length = 0;
    setters.length = 0;
    mockEffectCb = null;
    fetchMock.mockReset();
  });

  it("keeps activate disabled until the validate route accepts the draft", async () => {
    const apiMessage = "Too small: expected number to be >0";
    setupFetch({
      validate: {
        ok: false,
        status: 400,
        body: {
          valid: false,
          errors: [`perTxCapXLM: ${apiMessage}`],
          fieldErrors: { perTxCapXLM: [apiMessage] },
        },
      },
    });

    renderEditor();
    expect(mockEffectCb).not.toBeNull();
    mockEffectCb!();
    await flush();
    expect(getStatus()).toBe("Policy loaded.");

    // Gate is closed before any successful validation.
    let activateButton = findByTestId(renderEditor(), "activate-policy-button");
    expect(activateButton?.props?.disabled).toBe(true);

    // Run validation — it fails with the API's field errors.
    click(findByTestId(renderEditor(), "validate-draft-button"));
    await flush();

    expect(getGate().status).toBe("invalid");
    expect(getGate().fieldErrors).toEqual({ perTxCapXLM: [apiMessage] });

    activateButton = findByTestId(renderEditor(), "activate-policy-button");
    expect(activateButton?.props?.disabled).toBe(true);

    // The editor shows the API error for that rule, verbatim.
    const alert = findByTestId(renderEditor(), "policy-validation-status");
    expect(alert).toBeDefined();
    expect(treeText(alert)).toContain(`perTxCapXLM: ${apiMessage}`);
  });

  it("does not activate an invalid document, even if activate is triggered directly", async () => {
    setupFetch({
      validate: {
        ok: false,
        status: 422,
        body: {
          valid: false,
          errors: ['Duplicate rule identifier "dup.example.com" found in allowedDomains.'],
          code: "DUPLICATE_RULE_IDENTIFIER",
        },
      },
    });

    renderEditor();
    mockEffectCb!();
    await flush();

    // Bypass attempt: invoke the handler even though the button is disabled.
    click(findByTestId(renderEditor(), "activate-policy-button"));
    await flush();

    expect(policyPostCalls()).toHaveLength(0);
    expect(getGate().status).toBe("invalid");
    expect(getStatus()).toContain("Activation blocked");

    // The duplicate-rule API error is shown unmodified.
    expect(treeText(findByTestId(renderEditor(), "policy-validation-status"))).toContain(
      'Duplicate rule identifier "dup.example.com" found in allowedDomains.'
    );
  });

  it("activates a valid document exactly once", async () => {
    setupFetch({
      validate: { ok: true, status: 200, body: { valid: true, data: POLICY } },
      policyPost: {
        ok: true,
        status: 200,
        body: { policy: POLICY, updatedAt: "2026-09-30T01:00:00.000Z", version: 2 },
      },
    });

    renderEditor();
    mockEffectCb!();
    await flush();
    expect(getStatus()).toBe("Policy loaded.");

    // Validate the draft first.
    click(findByTestId(renderEditor(), "validate-draft-button"));
    await flush();
    expect(getGate().status).toBe("valid");

    const activateButton = findByTestId(renderEditor(), "activate-policy-button");
    expect(activateButton?.props?.disabled).toBe(false);

    click(activateButton);
    await flush();

    expect(getStatus()).toBe("Policy activated successfully.");
    expect(policyPostCalls()).toHaveLength(1);
    expect(policyPostCalls()[0].init.body).toContain('"expectedVersion":1');
  });
});
