import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DecisionResultView,
  redactVisibleReason,
  type EngineDecisionResult,
} from "@/components/decision-result-view";

const STELLAR_SECRET = "SBZVMB74Z76QZ3ZOY7UTDFYKMEGKW5XFJEB6PFKBF4UYSSWHG4EDH7PY";

const allowFixture: EngineDecisionResult = {
  decision: "APPROVE",
  explanation: "Fortexa approved this action.",
  riskScore: 10,
  triggeredPolicies: [{ code: "ALLOWLIST_DOMAIN_MATCH", message: "Domain is allowlisted." }],
  riskFindings: [],
};

const denyFixture: EngineDecisionResult = {
  decision: "BLOCK",
  explanation: `Blocked. Tool output leaked secret=${STELLAR_SECRET} to the agent.`,
  riskScore: 95,
  reasonCode: "BLOCKLIST_MATCH",
  triggeredPolicies: [{ code: "DOMAIN_DENYLIST", message: "Domain is denied." }],
  riskFindings: [{ code: "SECRET_TARGETING", detail: `Output contained ${STELLAR_SECRET}` }],
};

function render(result: EngineDecisionResult | null) {
  return renderToStaticMarkup(<DecisionResultView result={result} />);
}

describe("DecisionResultView", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("network access is not allowed in this test");
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("shows the engine rule id for an allow", () => {
    const html = render(allowFixture);
    expect(html).toContain('data-decision="APPROVE"');
    expect(html).toMatch(/data-testid="decision-rule-ids"[^>]*>ALLOWLIST_DOMAIN_MATCH</);
  });

  it("shows the engine decision and reason code for a deny, not a generic failure", () => {
    const html = render(denyFixture);
    expect(html).toContain('data-decision="BLOCK"');
    expect(html).toMatch(
      /data-testid="decision-reason-codes"[^>]*>BLOCKLIST_MATCH, SECRET_TARGETING</
    );
    expect(html).toMatch(/data-testid="decision-rule-ids"[^>]*>DOMAIN_DENYLIST</);
    expect(html).not.toMatch(/failed/i);
  });

  it("does not render a secret from the fixture reason", () => {
    const html = render(denyFixture);
    expect(html).not.toContain(STELLAR_SECRET);
    expect(html).toContain("[REDACTED]");
  });

  it("renders the empty state for an empty result, not an allow", () => {
    const html = render(null);
    expect(html).toContain('data-testid="decision-empty"');
    expect(html).not.toContain("APPROVE");
  });

  it("leaves text without secrets unchanged", () => {
    expect(redactVisibleReason("Domain api.example.com matched rule R-7.")).toBe(
      "Domain api.example.com matched rule R-7."
    );
  });
});
