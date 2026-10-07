import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DecisionBadge } from "@/components/decision-badge";
import type { EngineDecisionResult } from "@/components/decision-result-view";

const STELLAR_SECRET = "SBZVMB74Z76QZ3ZOY7UTDFYKMEGKW5XFJEB6PFKBF4UYSSWHG4EDH7PY";
const STELLAR_DESTINATION = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SIGNED_XDR = "AAAAAGLZz...fake_signed_xdr_payload...=";

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
  riskFindings: [
    { code: "SECRET_TARGETING", detail: `Output contained ${STELLAR_SECRET}` },
  ],
};

describe("DecisionBadge Component", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("network / Horizon access is not allowed in this test");
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("an allow fixture shows the engine allow code", () => {
    const html = renderToStaticMarkup(<DecisionBadge result={allowFixture} />);
    expect(html).toContain("APPROVE");
    expect(html).toContain('data-decision="APPROVE"');
  });

  it("an allow decision string shows the engine allow code", () => {
    const html = renderToStaticMarkup(<DecisionBadge decision="APPROVE" />);
    expect(html).toContain("APPROVE");
    expect(html).toContain('data-decision="APPROVE"');
  });

  it("a deny fixture shows the engine deny code", () => {
    const html = renderToStaticMarkup(<DecisionBadge result={denyFixture} />);
    expect(html).toContain("BLOCK");
    expect(html).toContain('data-decision="BLOCK"');
    expect(html).toContain('data-reason-code="BLOCKLIST_MATCH"');
  });

  it("a deny decision string shows the engine deny code", () => {
    const html = renderToStaticMarkup(<DecisionBadge decision="BLOCK" />);
    expect(html).toContain("BLOCK");
    expect(html).toContain('data-decision="BLOCK"');
  });

  it("a secret in the fixture payload is not rendered", () => {
    const payloadWithSecret = {
      result: denyFixture,
      secret: STELLAR_SECRET,
      seed: "S1234567890123456789012345678901234567890123456789012345",
      explanation: `Leaked secret ${STELLAR_SECRET}`,
    };
    const html = renderToStaticMarkup(<DecisionBadge payload={payloadWithSecret} />);
    expect(html).not.toContain(STELLAR_SECRET);
    expect(html).not.toContain("S1234567890");
    expect(html).toContain("BLOCK");
  });

  it("does not render amount, destination, memo, or signed XDR", () => {
    const payloadWithPayment = {
      result: allowFixture,
      amount: "1500.00",
      amountXLM: 1500,
      destination: STELLAR_DESTINATION,
      memo: "Confidential invoice payment",
      signedXDR: SIGNED_XDR,
      xdr: SIGNED_XDR,
    };
    const html = renderToStaticMarkup(<DecisionBadge payload={payloadWithPayment} />);
    expect(html).toContain("APPROVE");
    expect(html).not.toContain("1500");
    expect(html).not.toContain(STELLAR_DESTINATION);
    expect(html).not.toContain("Confidential invoice payment");
    expect(html).not.toContain(SIGNED_XDR);
  });

  it("an empty result shows no allow badge", () => {
    expect(renderToStaticMarkup(<DecisionBadge decision="" />)).toBe("");
    expect(renderToStaticMarkup(<DecisionBadge result={null} />)).toBe("");
    expect(renderToStaticMarkup(<DecisionBadge payload={{}} />)).toBe("");
    expect(renderToStaticMarkup(<DecisionBadge decision={null as unknown as string} />)).toBe("");
  });

  it("rejects non-engine codes or raw secrets passed as decision", () => {
    expect(renderToStaticMarkup(<DecisionBadge decision={STELLAR_SECRET} />)).toBe("");
    expect(renderToStaticMarkup(<DecisionBadge decision="100 XLM" />)).toBe("");
    expect(renderToStaticMarkup(<DecisionBadge decision="INVALID_ARBITRARY_STATUS" />)).toBe("");
  });

  it("renders WARN and REQUIRE_APPROVAL engine codes correctly", () => {
    const warnHtml = renderToStaticMarkup(<DecisionBadge decision="WARN" />);
    expect(warnHtml).toContain("WARN");
    expect(warnHtml).toContain('data-decision="WARN"');

    const requireHtml = renderToStaticMarkup(<DecisionBadge decision="REQUIRE_APPROVAL" />);
    expect(requireHtml).toContain("REQUIRE_APPROVAL");
    expect(requireHtml).toContain('data-decision="REQUIRE_APPROVAL"');
  });
});
