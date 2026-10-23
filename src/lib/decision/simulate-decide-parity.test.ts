import { describe, expect, it } from "vitest";

import { evaluateDecision, getPrimaryRuleId } from "@/lib/decision/engine";
import { simulatePolicyChange } from "@/lib/decision/simulate";
import { parityFixtures, parityPolicy, parityUsage } from "@/lib/decision/decision-parity-fixtures";

/**
 * Drift guard for issue #209.
 *
 * Simulates and live-decides the SAME shared fixtures through the SAME engine
 * function and requires the same allow/deny plus the same rule id.
 *
 * If simulate special-cases a rule the engine does not (or vice versa), this
 * fails. Tests never build or submit a transaction — only evaluateDecision
 * and simulatePolicyChange are called.
 */
describe("simulate / decide parity (issue #209)", () => {
  it("allow and deny fixtures match across simulate and decide with the same rule id", async () => {
    for (const fixture of parityFixtures) {
      // Live path: exactly how /api/decision evaluates (engine + payment).
      const live = await evaluateDecision(
        fixture.action,
        parityPolicy,
        parityUsage,
        fixture.payment
      );

      // Simulate path: exactly how /api/policy/simulate evaluates.
      const report = await simulatePolicyChange({
        currentPolicy: parityPolicy,
        proposedPolicy: { ...parityPolicy },
        cases: [
          {
            id: `parity:${fixture.id}`,
            label: fixture.label,
            source: "scenario",
            action: fixture.action,
            payment: fixture.payment,
          },
        ],
        usage: parityUsage,
      });

      const simulated = report.cases[0]!.current;
      const simulatedProposed = report.cases[0]!.proposed;

      // Expected outcome from the shared fixture.
      expect(live.decision, `${fixture.id} live decision`).toBe(fixture.expectedDecision);
      expect(getPrimaryRuleId(live), `${fixture.id} live rule id`).toBe(fixture.expectedRuleId);

      // Simulate agrees with live, including the rule id — not just free text.
      expect(simulated.decision, `${fixture.id} simulated decision`).toBe(live.decision);
      expect(getPrimaryRuleId(simulated), `${fixture.id} simulated rule id`).toBe(
        getPrimaryRuleId(live)
      );
      expect(simulated.primaryRuleId, `${fixture.id} response rule id`).toBe(live.primaryRuleId);
      expect(
        simulated.triggeredPolicies.map((t) => t.code),
        `${fixture.id} trigger codes`
      ).toEqual(live.triggeredPolicies.map((t) => t.code));

      // Same-policy simulation must not report a change.
      expect(simulatedProposed.decision).toBe(simulated.decision);
      expect(report.summary.changed).toBe(0);
    }
  });

  it("a memo-required destination matches across both entry points", async () => {
    const missing = parityFixtures.find((f) => f.id === "memo-required-missing")!;
    const present = parityFixtures.find((f) => f.id === "memo-required-present")!;

    const liveMissing = await evaluateDecision(
      missing.action,
      parityPolicy,
      parityUsage,
      missing.payment
    );
    const livePresent = await evaluateDecision(
      present.action,
      parityPolicy,
      parityUsage,
      present.payment
    );

    expect(liveMissing.decision).toBe("BLOCK");
    expect(getPrimaryRuleId(liveMissing)).toBe("MEMO_REQUIRED_MISSING");
    expect(livePresent.decision).toBe("APPROVE");

    const report = await simulatePolicyChange({
      currentPolicy: parityPolicy,
      proposedPolicy: { ...parityPolicy },
      cases: [
        {
          id: "parity:memo-required-missing",
          label: missing.label,
          source: "scenario",
          action: missing.action,
          payment: missing.payment,
        },
        {
          id: "parity:memo-required-present",
          label: present.label,
          source: "scenario",
          action: present.action,
          payment: present.payment,
        },
      ],
      usage: parityUsage,
    });

    const simMissing = report.cases[0]!.current;
    const simPresent = report.cases[1]!.current;

    expect(simMissing.decision).toBe(liveMissing.decision);
    expect(getPrimaryRuleId(simMissing)).toBe("MEMO_REQUIRED_MISSING");
    expect(simMissing.primaryRuleId).toBe(liveMissing.primaryRuleId);

    expect(simPresent.decision).toBe(livePresent.decision);
    expect(getPrimaryRuleId(simPresent)).toBe(null);
  });

  it("fails if simulate special-cases a rule the engine does not (asset/amount/destination/memo)", async () => {
    // Each tampered payment field must BLOCK with a specific rule id in BOTH
    // paths. A simulate implementation that ignores any of asset, amount,
    // destination, or memo would APPROVE here and fail this test.
    const base = parityFixtures[0]!;

    const tampered: Array<{
      name: string;
      payment: typeof base.payment;
      expectedRuleId: string;
    }> = [
      {
        name: "asset",
        payment: { ...base.payment, asset: "USDC" },
        expectedRuleId: "UNSUPPORTED_ASSET",
      },
      {
        name: "amount",
        payment: { ...base.payment, amount: 19 },
        expectedRuleId: "PAYMENT_AMOUNT_MISMATCH",
      },
      {
        name: "destination",
        payment: { ...base.payment, destination: "NOT_A_KEY" },
        expectedRuleId: "INVALID_DESTINATION",
      },
      {
        name: "memo",
        payment: {
          ...base.payment,
          destination: parityPolicy.memoRequiredDestinations![0]!,
          memo: "",
        },
        expectedRuleId: "MEMO_REQUIRED_MISSING",
      },
    ];

    for (const t of tampered) {
      const live = await evaluateDecision(base.action, parityPolicy, parityUsage, t.payment);
      const report = await simulatePolicyChange({
        currentPolicy: parityPolicy,
        proposedPolicy: { ...parityPolicy },
        cases: [
          {
            id: `parity:tamper-${t.name}`,
            label: `Tampered ${t.name}`,
            source: "scenario",
            action: base.action,
            payment: t.payment,
          },
        ],
        usage: parityUsage,
      });
      const simulated = report.cases[0]!.current;

      expect(live.decision, `tampered ${t.name} live`).toBe("BLOCK");
      expect(getPrimaryRuleId(live), `tampered ${t.name} live rule`).toBe(t.expectedRuleId);
      expect(simulated.decision, `tampered ${t.name} simulated`).toBe("BLOCK");
      expect(getPrimaryRuleId(simulated), `tampered ${t.name} simulated rule`).toBe(
        t.expectedRuleId
      );
      expect(simulated.primaryRuleId).toBe(live.primaryRuleId);
    }
  });

  it("does not build or submit transactions", async () => {
    // Guard: this test file must stay pure evaluation. If anyone imports the
    // Stellar build/submit path here, the parity claim is void.
    // Note: banned tokens are assembled via concatenation so this guard does
    // not match itself.
    const fs = await import("node:fs");
    const url = new URL(import.meta.url);
    const source = fs.readFileSync(url, "utf8");
    const banned = [
      "build" + "-payment",
      "submit" + "-signed",
      "build" + "UnsignedPaymentTransaction",
      "submit" + "StellarTransaction",
    ];
    for (const token of banned) {
      expect(source.includes(token), `parity test must not reference ${token}`).toBe(false);
    }
  });
});
