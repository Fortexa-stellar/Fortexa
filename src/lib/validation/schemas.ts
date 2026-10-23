import { z } from "zod";

import { parseXlmNumberToStroops } from "@/lib/stellar/stroops";
import {
  isValidPaymentAmountNumber,
  isValidPaymentAmountString,
  PAYMENT_AMOUNT_ERROR,
} from "@/lib/stellar/verify-payment-quote";

const ASSET_DECIMAL_ERROR = "Amount has more decimal places than the asset allows.";

function withinAssetDecimals(value: number): boolean {
  return parseXlmNumberToStroops(value).ok;
}

export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 255;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
export const IDEMPOTENCY_KEY_ERROR =
  "Idempotency-Key must be 8–255 characters and contain only letters, numbers, dots, underscores, and hyphens.";

export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN, { message: IDEMPOTENCY_KEY_ERROR })
  .max(IDEMPOTENCY_KEY_MAX, { message: IDEMPOTENCY_KEY_ERROR })
  .regex(IDEMPOTENCY_KEY_PATTERN, { message: IDEMPOTENCY_KEY_ERROR });

export function validateIdempotencyKey(
  key: string | undefined
): { ok: true; key: string } | { ok: false; error: string } {
  const trimmed = key?.trim() ?? "";
  if (trimmed.length === 0) {
    return { ok: false, error: IDEMPOTENCY_KEY_ERROR };
  }

  const parsed = idempotencyKeySchema.safeParse(trimmed);
  if (!parsed.success) {
    return { ok: false, error: IDEMPOTENCY_KEY_ERROR };
  }

  return { ok: true, key: parsed.data };
}

const actionKindSchema = z.enum(["api_payment", "tool_access", "transfer", "endpoint_call"]);

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const agentActionShape = {
  id: z.string().min(1).max(120),
  name: z.string().min(3).max(200),
  kind: actionKindSchema,
  target: z.string().min(3).max(400),
  domain: z.string().min(3).max(255),
  amountXLM: z.number().positive().max(100000),
  tool: z.string().min(1).max(120).optional(),
  outputPreview: z.string().min(1).max(2000).optional(),
  metadata: z.record(z.string(), metadataValueSchema).optional(),
};

export const agentActionSchema = z.object(agentActionShape);

/**
 * Strict variant of the action schema used for untrusted model output: unknown
 * keys are rejected instead of silently stripped.
 */
const strictAgentActionSchema = z.strictObject(agentActionShape);

export const stellarPublicKeySchema = z
  .string()
  .startsWith("G", { message: "Destination must be a Stellar public key." })
  .min(56)
  .max(56);

const paymentQuoteInputSchema = z.object({
  destination: stellarPublicKeySchema,
  memo: z.string().max(28).optional(),
  network: z.enum(["testnet"]).default("testnet"),
  asset: z.enum(["native"]).default("native"),
});

export const decisionRequestSchema = z
  .object({
    scenarioId: z.string().min(1).max(120).optional(),
    action: agentActionSchema.optional(),
    approvedByHuman: z.boolean().optional(),
    paymentQuoteInput: paymentQuoteInputSchema.optional(),
  })
  .refine(
    (data) =>
      Boolean(data.scenarioId || data.action || data.paymentQuote || data.paymentQuoteInput),
    {
      message: "Either scenarioId, action, or paymentQuote must be provided.",
      path: ["scenarioId"],
    }
  );

export const stellarSetupRequestSchema = z.object({
  provider: z.string().trim().min(1).max(60).optional(),
});

export const stellarBuildPaymentRequestSchema = z.object({
  auditEntryId: z.string().uuid(),
  destination: stellarPublicKeySchema,
  amountXLM: z
    .string()
    .regex(
      /^\d+(\.\d{1,7})?$/,
      "amountXLM must be a positive decimal string with up to 7 decimals"
    ),
  asset: z.enum(["native"]).default("native"),
  memo: z.string().max(28).optional(),
  network: z.enum(["testnet"]).default("testnet"),
  /**
   * Optional epoch-millisecond timestamp the client attaches to this
   * request, checked against the configured clock-skew window (see
   * src/lib/stellar/request-timestamp-skew.ts). Omitted entirely, the
   * check is skipped -- existing clients are unaffected.
   */
  requestTimestampMs: z.number().finite().optional(),
});

const decisionReceiptSchema = z.object({
  destination: stellarPublicKeySchema,
  amountXLM: z.string().refine(isValidPaymentAmountString, {
    message: PAYMENT_AMOUNT_ERROR,
  }),
  asset: z.enum(["native"]).default("native"),
  memo: z.string().min(1).max(28),
  network: z.enum(["testnet"]).default("testnet"),
  receiptHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export const stellarSubmitSignedRequestSchema = z.object({
  signedXdr: z.string().min(20).max(120000),
  decisionReceipt: decisionReceiptSchema,
  idempotencyKey: idempotencyKeySchema.optional(),
});

export const agentPlanRequestSchema = z.object({
  goal: z.string().min(5).max(2000),
  context: z.string().max(4000).optional(),
  destinationHint: z.string().startsWith("G").min(56).max(56).optional(),
});

/**
 * Strict schema for raw planner output.
 *
 * Model output must match this shape exactly before anything is stored or
 * evaluated: unknown keys are rejected and no coercion/casting is performed.
 * Any drift from the schema means the payload is ignored entirely instead of
 * partially influencing an agent plan.
 */
export const agentPlanSchema = z.strictObject({
  id: z.string().min(1).max(120),
  action: strictAgentActionSchema,
});

export const policyConfigSchema = z.object({
  allowedDomains: z.array(z.string().min(3)).min(1),
  blockedDomains: z.array(z.string().min(3)).min(1),
  allowedTools: z.array(z.string().min(1)).min(1),
  blockedTools: z.array(z.string().min(1)).min(1),
  perTxCapXLM: z.number().positive().max(1_000_000).refine(withinAssetDecimals, {
    message: ASSET_DECIMAL_ERROR,
  }),
  dailyCapXLM: z.number().positive().max(1_000_000).refine(withinAssetDecimals, {
    message: ASSET_DECIMAL_ERROR,
  }),
  perTxCapStroops: z.string().regex(/^\d+$/).optional(),
  dailyCapStroops: z.string().regex(/^\d+$/).optional(),
  maxToolCallsPerDay: z.number().int().positive().max(10_000),
  riskThreshold: z.number().int().min(1).max(100),
  allowedHours: z.object({
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(0).max(23),
  }),
  memoRequiredDestinations: z.array(z.string().min(3).max(56)).default([]),
});

export const policyRollbackSchema = z.object({
  targetVersion: z.number().int().positive(),
});

export const policyRollbackPreviewSchema = z.object({
  targetVersion: z.number().int().positive(),
  includeAudit: z.boolean().optional(),
  auditSampleSize: z.number().int().min(1).max(10).optional(),
});

export const policySimulateRequestSchema = z.object({
  policy: policyConfigSchema,
  includeAudit: z.boolean().optional(),
  auditSampleSize: z.number().int().min(1).max(10).optional(),
});

export type AgentActionInput = z.infer<typeof agentActionSchema>;
export type AgentPlanInput = z.infer<typeof agentPlanSchema>;
export type DecisionRequestInput = z.infer<typeof decisionRequestSchema>;
export type AgentPlanRequestInput = z.infer<typeof agentPlanRequestSchema>;
export type PolicySimulateRequestInput = z.infer<typeof policySimulateRequestSchema>;
