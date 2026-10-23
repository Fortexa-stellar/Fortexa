import { createHmac, randomUUID } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-auth", () => ({
  requireAuth: vi.fn().mockReturnValue({
    ok: true,
    session: { userId: "test-user-id", role: "operator", email: "operator@test.local" },
  }),
}));

vi.mock("@/lib/stellar/verify-payment-quote", () => ({
  isValidPaymentAmountNumber: vi.fn(() => true),
  isValidPaymentAmountString: vi.fn(() => true),
  PAYMENT_AMOUNT_ERROR: "Invalid payment amount.",
  buildDecisionReceipt: vi.fn(),
  buildPaymentQuoteFromDecision: vi.fn(),
  validateDecisionReceipt: vi.fn(),
  verifyPaymentAgainstQuote: vi.fn(),
  getQuoteExpiresAt: vi.fn(() => new Date(Date.now() + 60000).toISOString()),
  getQuoteTtlMs: vi.fn(() => 300000),
}));

const {
  generateAgentActionWithGroq,
  requestPlanCompletionContent,
  getGroqTimeoutMs,
  DEFAULT_GROQ_TIMEOUT_MS,
} = await import("@/lib/ai/groq");
const { PLAN_ERRORS, PLAN_ERROR_MESSAGES, PlanError } = await import("@/lib/ai/plan-errors");
const { POST } = await import("@/app/api/agent/plan/route");

const VALID_ACTION = {
  id: "act-001",
  name: "Research data fetch",
  kind: "api_payment" as const,
  target: "research-pro:fetch-report",
  domain: "api.safe-research.ai",
  amountXLM: 20,
  tool: "research-pro",
  outputPreview: "Fetching report.",
  metadata: {},
};

const VALID_PLAN_PAYLOAD = {
  id: "plan-001",
  action: VALID_ACTION,
};

const VALID_INPUT = { goal: "Fetch the latest research report for the portfolio." };

function planRequest(body: unknown) {
  return new NextRequest("http://localhost/api/agent/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("AI planning abort timeout & error mapping", () => {
  const originalEnvKey = process.env.GROQ_API_KEY;
  const originalTimeout = process.env.GROQ_TIMEOUT_MS;

  beforeEach(() => {
    process.env.GROQ_API_KEY = "test-groq-key";
    delete process.env.GROQ_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnvKey) {
      process.env.GROQ_API_KEY = originalEnvKey;
    } else {
      delete process.env.GROQ_API_KEY;
    }
    if (originalTimeout) {
      process.env.GROQ_TIMEOUT_MS = originalTimeout;
    } else {
      delete process.env.GROQ_TIMEOUT_MS;
    }
  });

  describe("Timeout configuration (GROQ_TIMEOUT_MS)", () => {
    it("uses default timeout when GROQ_TIMEOUT_MS is not set", () => {
      delete process.env.GROQ_TIMEOUT_MS;
      expect(getGroqTimeoutMs()).toBe(DEFAULT_GROQ_TIMEOUT_MS);
      expect(DEFAULT_GROQ_TIMEOUT_MS).toBe(15_000);
    });

    it("parses valid positive integers from GROQ_TIMEOUT_MS", () => {
      process.env.GROQ_TIMEOUT_MS = "8000";
      expect(getGroqTimeoutMs()).toBe(8000);
    });

    it("falls back to default timeout when GROQ_TIMEOUT_MS is invalid or negative", () => {
      process.env.GROQ_TIMEOUT_MS = "invalid";
      expect(getGroqTimeoutMs()).toBe(DEFAULT_GROQ_TIMEOUT_MS);

      process.env.GROQ_TIMEOUT_MS = "-500";
      expect(getGroqTimeoutMs()).toBe(DEFAULT_GROQ_TIMEOUT_MS);
    });
  });

  describe("Bounding AI planning calls with an abort timeout", () => {
    it("attaches an AbortSignal to the fetch request with the configured timeout", async () => {
      let capturedSignal: AbortSignal | null | undefined;

      vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        capturedSignal = init?.signal;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(VALID_PLAN_PAYLOAD) } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      await generateAgentActionWithGroq(VALID_INPUT, { timeoutMs: 5000 });

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
    });

    it("combines an optional caller signal with the timeout signal", async () => {
      const callerController = new AbortController();
      let capturedSignal: AbortSignal | null | undefined;

      vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        capturedSignal = init?.signal;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(VALID_PLAN_PAYLOAD) } }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      });

      await generateAgentActionWithGroq(VALID_INPUT, {
        signal: callerController.signal,
        timeoutMs: 10_000,
      });

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);

      callerController.abort();
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe("Mapping timeout failures to stable plan error response", () => {
    it("maps fetch AbortError to PLAN_PROVIDER_UNAVAILABLE PlanError", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        const abortError = new DOMException("The operation was aborted.", "AbortError");
        return Promise.reject(abortError);
      });

      let caught: unknown;
      try {
        await generateAgentActionWithGroq(VALID_INPUT, { timeoutMs: 1000 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PlanError);
      expect((caught as PlanError).code).toBe(PLAN_ERRORS.PROVIDER_UNAVAILABLE);
      expect((caught as PlanError).message).toMatch(/timed out/i);
    });

    it("maps fetch TimeoutError to PLAN_PROVIDER_UNAVAILABLE PlanError", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
        return Promise.reject(timeoutError);
      });

      let caught: unknown;
      try {
        await generateAgentActionWithGroq(VALID_INPUT, { timeoutMs: 2000 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PlanError);
      expect((caught as PlanError).code).toBe(PLAN_ERRORS.PROVIDER_UNAVAILABLE);
      expect((caught as PlanError).message).toMatch(/timed out/i);
    });

    it("maps timeout failures to HTTP 422 with PLAN_PROVIDER_UNAVAILABLE in the plan route", async () => {
      vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        const timeoutError = new DOMException("The operation timed out.", "TimeoutError");
        return Promise.reject(timeoutError);
      });

      const response = await POST(planRequest({ goal: "Fetch research report please." }));

      expect(response.status).toBe(422);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe(PLAN_ERRORS.PROVIDER_UNAVAILABLE);
      expect(body.error).toBe(PLAN_ERROR_MESSAGES[PLAN_ERRORS.PROVIDER_UNAVAILABLE]);
    });

    it("maps raw AbortError thrown inside the plan route to HTTP 422 with PLAN_PROVIDER_UNAVAILABLE", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(
        new DOMException("The operation was aborted.", "AbortError")
      );

      const response = await POST(planRequest({ goal: "Fetch research report please." }));

      expect(response.status).toBe(422);
      const body = (await response.json()) as { code: string; error: string };
      expect(body.code).toBe(PLAN_ERRORS.PROVIDER_UNAVAILABLE);
      expect(body.error).toBe(PLAN_ERROR_MESSAGES[PLAN_ERRORS.PROVIDER_UNAVAILABLE]);
    });
  });

  describe("Preserves normal behavior outside timeout", () => {
    it("returns successful plan completion when request succeeds within timeout", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(VALID_PLAN_PAYLOAD) } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const result = await requestPlanCompletionContent(VALID_INPUT);
      expect(result).toBe(JSON.stringify(VALID_PLAN_PAYLOAD));
    });
  });
});
