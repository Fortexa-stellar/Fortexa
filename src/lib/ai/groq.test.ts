import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GROQ_API_KEY = "test-groq-key";
});

import { generateAgentActionWithGroq } from "@/lib/ai/groq";
import { PLAN_ERRORS, PlanError } from "@/lib/ai/plan-errors";

const VALID_ACTION = {
  id: "act-001",
  name: "Research data fetch",
  kind: "api_payment",
  target: "research-pro:fetch-report",
  domain: "api.safe-research.ai",
  amountXLM: 20,
  tool: "research-pro",
  outputPreview: "Fetching latest market report.",
  metadata: {},
};

function mockGroqResponse(content: string, status = 200) {
  const body =
    status === 200
      ? JSON.stringify({
          choices: [{ message: { content } }],
        })
      : "Provider error";

  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(JSON.parse(body)),
    })
  );
}

function mockGroqEmptyContent() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: "" } }] }),
    })
  );
}

function mockGroqMissingChoices() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    })
  );
}

beforeEach(() => {
  process.env.GROQ_API_KEY = "test-groq-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const VALID_INPUT = { goal: "Fetch the latest research report for the portfolio." };

describe("generateAgentActionWithGroq — failure catalog", () => {
  describe("PLAN_PROVIDER_UNAVAILABLE", () => {
    it("throws when GROQ_API_KEY is missing", async () => {
      delete process.env.GROQ_API_KEY;

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.PROVIDER_UNAVAILABLE
      );
    });

    it("throws when Groq returns a non-200 status", async () => {
      mockGroqResponse("error body", 503);

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.PROVIDER_UNAVAILABLE
      );
    });

    it("throws when Groq returns 401 Unauthorized", async () => {
      mockGroqResponse("Unauthorized", 401);

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.PROVIDER_UNAVAILABLE
      );
    });

    it("error message does not expose raw provider response body", async () => {
      mockGroqResponse("SECRET_INTERNAL_DETAIL_XYZ", 503);

      const err = await generateAgentActionWithGroq(VALID_INPUT).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).message).not.toContain("SECRET_INTERNAL_DETAIL_XYZ");
    });
  });

  describe("PLAN_EMPTY_RESPONSE", () => {
    it("throws when model content is an empty string", async () => {
      mockGroqEmptyContent();

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.EMPTY_RESPONSE
      );
    });

    it("throws when choices array is absent", async () => {
      mockGroqMissingChoices();

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.EMPTY_RESPONSE
      );
    });
  });

  describe("PLAN_MALFORMED_JSON", () => {
    it("throws when model returns plain text with no JSON braces", async () => {
      mockGroqResponse("Sorry, I cannot generate a plan right now.");

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.MALFORMED_JSON
      );
    });

    it("throws when model returns truncated JSON", async () => {
      mockGroqResponse('{"id":"act-001","name":"Truncated plan"');

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.MALFORMED_JSON
      );
    });

    it("throws when model wraps non-JSON in a fenced block", async () => {
      mockGroqResponse("```json\nnot valid json at all\n```");

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.MALFORMED_JSON
      );
    });
  });

  describe("PLAN_SCHEMA_MISMATCH", () => {
    it("throws when model returns JSON missing required fields", async () => {
      mockGroqResponse(JSON.stringify({ id: "act-001", name: "Missing fields" }));

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.SCHEMA_MISMATCH
      );
    });

    it("throws when amountXLM is negative", async () => {
      mockGroqResponse(JSON.stringify({ ...VALID_ACTION, amountXLM: -10 }));

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.SCHEMA_MISMATCH
      );
    });

    it("throws when kind is not a valid enum value", async () => {
      mockGroqResponse(JSON.stringify({ ...VALID_ACTION, kind: "delete_account" }));

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.SCHEMA_MISMATCH
      );
    });

    it("throws when amountXLM exceeds the maximum allowed value", async () => {
      mockGroqResponse(JSON.stringify({ ...VALID_ACTION, amountXLM: 999999 }));

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.SCHEMA_MISMATCH
      );
    });
  });

  describe("PLAN_UNSAFE_TOOL", () => {
    it("throws when model returns a plan using a blocked tool", async () => {
      mockGroqResponse(JSON.stringify({ ...VALID_ACTION, tool: "shadow-shell" }));

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.UNSAFE_TOOL
      );
    });

    it("throws when model returns a plan using another blocked tool", async () => {
      mockGroqResponse(JSON.stringify({ ...VALID_ACTION, tool: "autonomous-payout-bypass" }));

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.UNSAFE_TOOL
      );
    });
  });

  describe("PLAN_UNSAFE_DOMAIN", () => {
    it("throws when model returns a plan targeting a blocked domain", async () => {
      mockGroqResponse(
        JSON.stringify({ ...VALID_ACTION, tool: undefined, domain: "wallet-drainer.evil" })
      );

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.UNSAFE_DOMAIN
      );
    });

    it("throws when model targets a known phishing domain in the blocklist", async () => {
      mockGroqResponse(
        JSON.stringify({ ...VALID_ACTION, tool: undefined, domain: "prompt-pwn.io" })
      );

      await expect(generateAgentActionWithGroq(VALID_INPUT)).rejects.toSatisfy(
        (err: unknown) => err instanceof PlanError && err.code === PLAN_ERRORS.UNSAFE_DOMAIN
      );
    });
  });
});

describe("generateAgentActionWithGroq — happy path", () => {
  it("returns a validated AgentAction when model output is well-formed", async () => {
    mockGroqResponse(JSON.stringify(VALID_ACTION));

    const action = await generateAgentActionWithGroq(VALID_INPUT);

    expect(action.id).toBe("act-001");
    expect(action.name).toBe("Research data fetch");
    expect(action.kind).toBe("api_payment");
    expect(action.domain).toBe("api.safe-research.ai");
    expect(action.amountXLM).toBe(20);
    expect(action.tool).toBe("research-pro");
  });

  it("accepts model output wrapped in a fenced JSON block", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_ACTION) + "\n```";
    mockGroqResponse(fenced);

    const action = await generateAgentActionWithGroq(VALID_INPUT);
    expect(action.kind).toBe("api_payment");
  });

  it("assigns a UUID when model omits the id field", async () => {
    const withoutId = { ...VALID_ACTION };
    delete (withoutId as { id?: string }).id;
    mockGroqResponse(JSON.stringify(withoutId));

    const action = await generateAgentActionWithGroq(VALID_INPUT);
    expect(typeof action.id).toBe("string");
    expect(action.id.length).toBeGreaterThan(0);
  });

  it("passes goal, context, and destinationHint to the Groq API", async () => {
    mockGroqResponse(JSON.stringify(VALID_ACTION));

    const fetchSpy = vi.mocked(fetch);

    await generateAgentActionWithGroq({
      goal: "Pay for research data.",
      context: "Portfolio rebalancing run.",
      destinationHint: "G".repeat(56),
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = body.messages.find((m) => m.role === "user")?.content ?? "";

    expect(userMessage).toContain("Pay for research data.");
    expect(userMessage).toContain("Portfolio rebalancing run.");
    expect(userMessage).toContain("G".repeat(56));
  });
});

describe("PlanError — error catalog shape", () => {
  it("exposes the correct code on the error instance", () => {
    const err = new PlanError(PLAN_ERRORS.MALFORMED_JSON);
    expect(err.code).toBe("PLAN_MALFORMED_JSON");
    expect(err.name).toBe("PlanError");
    expect(err).toBeInstanceOf(Error);
  });

  it("uses a custom detail message when provided", () => {
    const err = new PlanError(PLAN_ERRORS.PROVIDER_UNAVAILABLE, "Custom message.");
    expect(err.message).toBe("Custom message.");
  });

  it("falls back to the catalog message when no detail is given", () => {
    const err = new PlanError(PLAN_ERRORS.EMPTY_RESPONSE);
    expect(err.message).toBe("Model returned an empty response for the agent plan.");
  });
});
