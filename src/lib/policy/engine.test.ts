import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DuplicateRuleError,
  evaluatePolicy,
  defaultPolicyConfig,
  readAmountStroops,
  validateNoDuplicateRules,
} from "@/lib/policy/engine";
import type { AgentAction, DailyUsage, PolicyConfig } from "@/lib/types/domain";

const baseAction: AgentAction = {
  id: "action-safe-payment",
  name: "Safe research payment",
  kind: "api_payment",
  target: "Safe Research API",
  domain: "api.safe-research.ai",
  amountXLM: 25,
  tool: "research-pro",
};

const baseUsage: DailyUsage = {
  spentXLM: 50,
  toolCalls: 1,
  lastUpdated: "2026-05-26",
};

const basePolicy: PolicyConfig = {
  ...defaultPolicyConfig,
  allowedHours: undefined,
};

function evaluate(
  actionOverrides: Partial<AgentAction> = {},
  policyOverrides: Partial<PolicyConfig> = {},
  usageOverrides: Partial<DailyUsage> = {}
) {
  return evaluatePolicy(
    { ...baseAction, ...actionOverrides },
    { ...basePolicy, ...policyOverrides },
    { ...baseUsage, ...usageOverrides }
  );
}

function triggerCodes(
  actionOverrides?: Partial<AgentAction>,
  policyOverrides?: Partial<PolicyConfig>,
  usageOverrides?: Partial<DailyUsage>
) {
  return evaluate(actionOverrides, policyOverrides, usageOverrides).triggers.map(
    (trigger) => trigger.code
  );
}

describe("policy engine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows an explicitly approved domain and tool without triggers", () => {
    const result = evaluate();

    expect(result).toMatchObject({
      hardBlock: false,
      requireApproval: false,
      warning: false,
      triggers: [],
    });
  });

  it("hard-blocks a blocked domain and still records that it is not allowlisted", () => {
    const result = evaluate({ domain: "wallet-drainer.evil" });

    expect(result.hardBlock).toBe(true);
    expect(result.warning).toBe(true);
    expect(result.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BLOCKED_DOMAIN", severity: "high" }),
        expect.objectContaining({ code: "UNLISTED_DOMAIN", severity: "medium" }),
      ])
    );
  });

  it("warns for an unlisted domain that is not explicitly blocked", () => {
    const result = evaluate({ domain: "new-partner.example" });

    expect(result.hardBlock).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.triggers).toEqual([
      expect.objectContaining({ code: "UNLISTED_DOMAIN", severity: "medium" }),
    ]);
  });

  it("normalizes domains before allowlist checks (whitespace, casing, trailing dot, URL)", () => {
    expect(triggerCodes({ domain: " API.safe-research.ai  " })).not.toContain("UNLISTED_DOMAIN");
    expect(triggerCodes({ domain: "https://api.safe-research.ai/path?query=1" })).not.toContain(
      "UNLISTED_DOMAIN"
    );
    expect(triggerCodes({ domain: "api.safe-research.ai." })).not.toContain("UNLISTED_DOMAIN");
  });

  it("hard-blocks malformed domains", () => {
    const result = evaluate({ domain: "not a domain" });

    expect(result.hardBlock).toBe(true);
    expect(result.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MALFORMED_DOMAIN", severity: "high" }),
      ])
    );
  });

  it("hard-blocks a blocked tool and records unapproved tool use", () => {
    const result = evaluate({ tool: "shadow-shell" });

    expect(result.hardBlock).toBe(true);
    expect(result.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BLOCKED_TOOL", severity: "high" }),
        expect.objectContaining({ code: "UNAPPROVED_TOOL", severity: "medium" }),
      ])
    );
  });

  it("warns for an unapproved tool without hard-blocking", () => {
    const result = evaluate({ tool: "unreviewed-crawler" });

    expect(result.hardBlock).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.triggers).toEqual([
      expect.objectContaining({ code: "UNAPPROVED_TOOL", severity: "medium" }),
    ]);
  });

  it("does not evaluate tool allowlists when an action has no tool", () => {
    expect(triggerCodes({ tool: undefined })).not.toContain("UNAPPROVED_TOOL");
  });

  it("requires approval when the per-transaction cap is exceeded", () => {
    const result = evaluate({ amountXLM: basePolicy.perTxCapXLM + 1 });

    expect(result.requireApproval).toBe(true);
    expect(result.triggers).toEqual([
      expect.objectContaining({ code: "PER_TX_CAP_EXCEEDED", severity: "high" }),
    ]);
  });

  it("allows an amount exactly at the per-transaction cap", () => {
    expect(triggerCodes({ amountXLM: basePolicy.perTxCapXLM })).not.toContain(
      "PER_TX_CAP_EXCEEDED"
    );
  });

  it("requires approval when the daily cap would be exceeded", () => {
    const result = evaluate({ amountXLM: 75 }, {}, { spentXLM: basePolicy.dailyCapXLM - 74 });

    expect(result.requireApproval).toBe(true);
    expect(result.triggers).toEqual([
      expect.objectContaining({ code: "DAILY_CAP_EXCEEDED", severity: "high" }),
    ]);
  });

  it("allows usage exactly at the daily cap", () => {
    expect(
      triggerCodes({ amountXLM: 75 }, {}, { spentXLM: basePolicy.dailyCapXLM - 75 })
    ).not.toContain("DAILY_CAP_EXCEEDED");
  });

  it("warns when the next tool call would exceed the daily tool-call limit", () => {
    const result = evaluate({}, {}, { toolCalls: basePolicy.maxToolCallsPerDay });

    expect(result.warning).toBe(true);
    expect(result.triggers).toEqual([
      expect.objectContaining({ code: "TOOL_CALL_LIMIT_REACHED", severity: "medium" }),
    ]);
  });

  it("allows the final permitted tool call before the daily limit is reached", () => {
    expect(triggerCodes({}, {}, { toolCalls: basePolicy.maxToolCallsPerDay - 1 })).not.toContain(
      "TOOL_CALL_LIMIT_REACHED"
    );
  });

  it("allows actions inside the configured allowed-hours window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T12:00:00"));

    expect(triggerCodes({}, { allowedHours: { start: 9, end: 17 } })).not.toContain(
      "OUTSIDE_ALLOWED_TIME"
    );
  });

  it("allows actions on the allowed-hours start and end boundaries", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-05-26T09:00:00"));
    expect(triggerCodes({}, { allowedHours: { start: 9, end: 17 } })).not.toContain(
      "OUTSIDE_ALLOWED_TIME"
    );

    vi.setSystemTime(new Date("2026-05-26T17:59:59.999"));
    expect(triggerCodes({}, { allowedHours: { start: 9, end: 17 } })).not.toContain(
      "OUTSIDE_ALLOWED_TIME"
    );
  });

  it("warns outside the configured allowed-hours window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T22:00:00"));

    const result = evaluate({}, { allowedHours: { start: 9, end: 17 } });

    expect(result.warning).toBe(true);
    expect(result.triggers).toEqual([
      expect.objectContaining({ code: "OUTSIDE_ALLOWED_TIME", severity: "medium" }),
    ]);
  });

  it("treats empty allowlists as warnings rather than hard blocks", () => {
    const result = evaluate({}, { allowedDomains: [], allowedTools: [] });

    expect(result.hardBlock).toBe(false);
    expect(result.warning).toBe(true);
    expect(result.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "UNLISTED_DOMAIN" }),
        expect.objectContaining({ code: "UNAPPROVED_TOOL" }),
      ])
    );
  });
  describe("cap arithmetic is exact", () => {
    // In binary floating point 0.1 + 0.2 is 0.30000000000000004, which is
    // strictly greater than a 0.3 cap. Comparing in stroops removes the drift,
    // so a payment that lands exactly on a cap is allowed and one stroop more
    // is not.
    it("allows a payment that lands exactly on the daily cap", () => {
      expect(
        triggerCodes({ amountXLM: 0.2 }, { dailyCapXLM: 0.3, perTxCapXLM: 120 }, { spentXLM: 0.1 })
      ).not.toContain("DAILY_CAP_EXCEEDED");

      expect(
        triggerCodes({ amountXLM: 2.2 }, { dailyCapXLM: 3.3, perTxCapXLM: 120 }, { spentXLM: 1.1 })
      ).not.toContain("DAILY_CAP_EXCEEDED");
    });

    it("blocks a payment one stroop over the daily cap", () => {
      expect(
        triggerCodes(
          { amountXLM: 0.2000001 },
          { dailyCapXLM: 0.3, perTxCapXLM: 120 },
          { spentXLM: 0.1 }
        )
      ).toContain("DAILY_CAP_EXCEEDED");
    });

    it("allows a payment that lands exactly on the per-transaction cap", () => {
      expect(
        triggerCodes({ amountXLM: 3.3 }, { perTxCapXLM: 3.3, dailyCapXLM: 1000 }, { spentXLM: 0 })
      ).not.toContain("PER_TX_CAP_EXCEEDED");
    });

    it("blocks a payment one stroop over the per-transaction cap", () => {
      expect(
        triggerCodes(
          { amountXLM: 3.3000001 },
          { perTxCapXLM: 3.3, dailyCapXLM: 1000 },
          { spentXLM: 0 }
        )
      ).toContain("PER_TX_CAP_EXCEEDED");
    });

    it("compares a stored cap integer with the payment stroops", () => {
      const cap = readAmountStroops(1);
      expect(cap).toBe(10_000_000n);

      expect(
        triggerCodes(
          { amountXLM: 1 },
          { perTxCapXLM: 1, perTxCapStroops: cap?.toString(), dailyCapXLM: 10 },
          { spentXLM: 0 }
        )
      ).not.toContain("PER_TX_CAP_EXCEEDED");

      expect(
        triggerCodes(
          { amountXLM: 1.0000001 },
          { perTxCapXLM: 1, perTxCapStroops: cap?.toString(), dailyCapXLM: 10 },
          { spentXLM: 0 }
        )
      ).toContain("PER_TX_CAP_EXCEEDED");
    });

    it("holds exactness at large amounts", () => {
      const atCap = triggerCodes(
        { amountXLM: 100000 },
        { perTxCapXLM: 100000, dailyCapXLM: 100000 },
        { spentXLM: 0 }
      );
      expect(atCap).not.toContain("PER_TX_CAP_EXCEEDED");
      expect(atCap).not.toContain("DAILY_CAP_EXCEEDED");

      const overCap = triggerCodes(
        { amountXLM: 100000.0000001 },
        { perTxCapXLM: 100000, dailyCapXLM: 100000 },
        { spentXLM: 0 }
      );
      expect(overCap).toContain("PER_TX_CAP_EXCEEDED");
    });
  });
});

describe("duplicate rule identifier detection", () => {
  it("reports the first duplicate found when multiple lists have duplicates", () => {
    const policy: PolicyConfig = {
      ...basePolicy,
      allowedDomains: ["api.safe-research.ai", "api.safe-research.ai"],
      blockedTools: ["shadow-shell", "shadow-shell"],
    };

    let error: DuplicateRuleError | null = null;
    try {
      validateNoDuplicateRules(policy);
    } catch (caught) {
      error = caught as DuplicateRuleError;
    }

    expect(error).not.toBeNull();
    expect(error!.field).toBe("allowedDomains");
  });

  it("is case-sensitive for tool identifiers", () => {
    const policy: PolicyConfig = {
      ...basePolicy,
      allowedTools: ["research-pro", "Research-Pro"],
    };

    expect(() => validateNoDuplicateRules(policy)).not.toThrow();
  });

  it("rejects duplicate rule identifiers from imported policy JSON", () => {
    const importedPolicy: PolicyConfig = {
      allowedDomains: ["api.safe-research.ai", "api.safe-research.ai"],
      blockedDomains: ["wallet-drainer.evil"],
      allowedTools: ["research-pro"],
      blockedTools: ["shadow-shell"],
      perTxCapXLM: 120,
      dailyCapXLM: 300,
      maxToolCallsPerDay: 8,
      riskThreshold: 78,
      allowedHours: { start: 6, end: 23 },
    };

    expect(() => validateNoDuplicateRules(importedPolicy)).toThrow(DuplicateRuleError);
  });

  it("rejects duplicate rule identifiers from a direct policy edit", () => {
    const editedPolicy: PolicyConfig = {
      ...basePolicy,
      allowedTools: ["research-pro", "research-pro"],
    };

    expect(() => validateNoDuplicateRules(editedPolicy)).toThrow(DuplicateRuleError);
  });
});
