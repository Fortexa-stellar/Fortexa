import { z } from "zod";

import { parseStoredPolicy } from "@/lib/policy/migrations";
import type { PolicyConfig } from "@/lib/types/domain";

const ruleLists = ["allowedDomains", "blockedDomains", "allowedTools", "blockedTools"] as const;

const exportEnvelopeSchema = z.strictObject({
  format: z.literal("fortexa-policy-export"),
  active: z.literal(true),
  version: z.number().int().positive(),
  policy: z.record(z.string(), z.unknown()),
});

export type PolicyExport = {
  format: "fortexa-policy-export";
  active: true;
  version: number;
  policy: PolicyConfig;
};

export function exportPolicyDocument(policy: PolicyConfig, version: number): PolicyExport {
  return { format: "fortexa-policy-export", active: true, version, policy };
}

export function parsePolicyImport(
  raw: unknown
): { ok: true; document: PolicyExport } | { ok: false; error: string } {
  const envelope = exportEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { ok: false, error: "Invalid policy export format or version." };
  }

  const parsed = parseStoredPolicy(envelope.data.policy);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  // Migration may fill optional settings, but must never alter rule identity or order.
  for (const field of ruleLists) {
    const original = envelope.data.policy[field];
    if (
      !Array.isArray(original) ||
      original.length !== parsed.policy[field].length ||
      original.some((id, index) => id !== parsed.policy[field][index])
    ) {
      return { ok: false, error: `Migration changed ${field} rule identifiers or order.` };
    }
  }

  return {
    ok: true,
    document: exportPolicyDocument(parsed.policy, envelope.data.version),
  };
}

export function policyImportMatchesActive(
  document: PolicyExport,
  active: {
    policy: PolicyConfig;
    version: number;
  }
): string | null {
  if (document.version !== active.version) {
    return `Policy version differs from the active export (v${active.version}).`;
  }

  for (const field of ruleLists) {
    const imported = document.policy[field];
    const current = active.policy[field];
    if (imported.length !== current.length || imported.some((id, index) => id !== current[index])) {
      return `${field} rule identifiers or order differ from the active policy.`;
    }
  }

  return null;
}
