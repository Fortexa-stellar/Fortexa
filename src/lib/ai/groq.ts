import { defaultPolicyConfig } from "@/lib/policy/engine";
import {
  agentPlanSchema,
  type AgentPlanInput,
  type AgentPlanRequestInput,
} from "@/lib/validation/schemas";
import { PLAN_ERRORS, PlanError } from "@/lib/ai/plan-errors";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

export type PlanCompletionContent = string;

function extractJsonObject(text: string) {
  const fencedMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1] ?? text;

  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new PlanError(PLAN_ERRORS.MALFORMED_JSON);
  }

  return candidate.slice(firstBrace, lastBrace + 1);
}

/**
 * Parse raw model output into a validated agent plan payload.
 *
 * Model output is untrusted: it is parsed against the strict plan schema
 * (`agentPlanSchema`) with unknown keys rejected and no coercion. Output that
 * drifts from the schema is rejected wholesale — it never feeds a partial
 * plan or influences policy state.
 *
 * No `id` fallback is injected here: the model output is either a complete,
 * schema-valid plan or it is rejected.
 */
export function parseAgentPlanFromContent(content: PlanCompletionContent): AgentPlanInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(content));
  } catch (err) {
    if (err instanceof PlanError) throw err;
    throw new PlanError(PLAN_ERRORS.MALFORMED_JSON);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PlanError(PLAN_ERRORS.SCHEMA_MISMATCH);
  }

  const result = agentPlanSchema.safeParse(parsed);

  if (!result.success) {
    throw new PlanError(PLAN_ERRORS.SCHEMA_MISMATCH);
  }

  return result.data;
}

export async function generateAgentPlanPayloadWithGroq(
  input: AgentPlanRequestInput
): Promise<AgentPlanInput> {
  const content = await requestPlanCompletionContent(input);
  return parseAgentPlanFromContent(content);
}

export async function requestPlanCompletionContent(
  input: AgentPlanRequestInput
): Promise<PlanCompletionContent> {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new PlanError(PLAN_ERRORS.PROVIDER_UNAVAILABLE, "GROQ_API_KEY is not configured.");
  }

  const systemPrompt = [
    "You are an AI agent planner for Fortexa.",
    "Return only one JSON object matching this schema:",
    '{"id":"string","action":{"id":"string","name":"string","kind":"api_payment|tool_access|transfer|endpoint_call","target":"string","domain":"string","amountXLM":number,"tool":"string(optional)","outputPreview":"string(optional)","metadata":{}}}',
    "Hard rules:",
    "- action.amountXLM must be a positive number with realistic testnet values (1-250).",
    "- action.domain must be a plausible hostname (no protocol).",
    "- action.target must be specific and stable, not random gibberish.",
    "- If uncertain, choose a conservative action under 50 XLM.",
    "- Do not include explanations, markdown, or extra text.",
  ].join("\n");

  const userPrompt = [
    `Goal: ${input.goal}`,
    input.context ? `Context: ${input.context}` : "",
    input.destinationHint ? `Destination hint: ${input.destinationHint}` : "",
    `Allowed domains example: ${defaultPolicyConfig.allowedDomains.join(", ")}`,
    `Blocked domains example: ${defaultPolicyConfig.blockedDomains.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const completionResponse = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!completionResponse.ok) {
    throw new PlanError(
      PLAN_ERRORS.PROVIDER_UNAVAILABLE,
      `Groq API responded with status ${completionResponse.status}.`
    );
  }

  const payload = (await completionResponse.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = payload.choices?.[0]?.message?.content;

  if (!content) {
    throw new PlanError(PLAN_ERRORS.EMPTY_RESPONSE);
  }

  return content;
}

/**
 * Backward-compatible single-action plan generation.
 *
 * The plan returned by the model is validated and generated through the same
 * schema path used for multi-item plans. Note: schema validation alone does
 * not authorize a payment — callers that move money must run the action
 * through the live decision engine first (see src/lib/ai/plan-filter.ts).
 */
export async function generateAgentActionWithGroq(input: AgentPlanRequestInput) {
  return generateAgentPlanPayloadWithGroq(input);
}
