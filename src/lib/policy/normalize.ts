import { defaultPolicyConfig, readAmountStroops } from "@/lib/policy/engine";
import type { PolicyConfig } from "@/lib/types/domain";

function stroopField(displayXlm: number): string | undefined {
  const stroops = readAmountStroops(displayXlm);
  return stroops === null ? undefined : stroops.toString();
}

export function normalizePolicy(policy?: Partial<PolicyConfig>): PolicyConfig {
  return {
    allowedDomains: policy?.allowedDomains ?? defaultPolicyConfig.allowedDomains,
    blockedDomains: policy?.blockedDomains ?? defaultPolicyConfig.blockedDomains,
    allowedTools: policy?.allowedTools ?? defaultPolicyConfig.allowedTools,
    blockedTools: policy?.blockedTools ?? defaultPolicyConfig.blockedTools,
    perTxCapXLM: policy?.perTxCapXLM ?? defaultPolicyConfig.perTxCapXLM,
    dailyCapXLM: policy?.dailyCapXLM ?? defaultPolicyConfig.dailyCapXLM,
    perTxCapStroops: stroopField(policy?.perTxCapXLM ?? defaultPolicyConfig.perTxCapXLM),
    dailyCapStroops: stroopField(policy?.dailyCapXLM ?? defaultPolicyConfig.dailyCapXLM),
    maxToolCallsPerDay: policy?.maxToolCallsPerDay ?? defaultPolicyConfig.maxToolCallsPerDay,
    riskThreshold: policy?.riskThreshold ?? defaultPolicyConfig.riskThreshold,
    allowedHours: policy?.allowedHours ?? defaultPolicyConfig.allowedHours,
    memoRequiredDestinations:
      policy?.memoRequiredDestinations ?? defaultPolicyConfig.memoRequiredDestinations ?? [],
  };
}
