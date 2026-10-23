import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { GET as metricsRoute } from "@/app/api/metrics/route";
import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import {
  getMetricsSnapshot,
  recordDecisionOutcome,
  recordRateLimitRejection,
  recordStellarSubmitResult,
  resetMetrics,
} from "@/lib/observability/metrics";
import type { MetricsSnapshot } from "@/lib/observability/metrics";

import { OpsDashboard } from "./ops-dashboard";

/**
 * Counter-parity tests for the ops dashboard.
 *
 * The dashboard is rendered from the in-process metrics snapshot handed to it by
 * the server loader, so these tests never stub `fetch` and never touch HTTP. The
 * only HTTP-shaped thing they exercise is `/api/metrics`' route handler, called
 * in-process, to prove the exported body encodes the same numbers.
 */

const fetchSpy = vi.fn();

function renderDashboard(snapshot?: MetricsSnapshot): string {
  return renderToStaticMarkup(
    createElement(OpsDashboard, snapshot ? { initialMetrics: snapshot } : {})
  );
}

function readCounter(markup: string, testId: string): string | null {
  const match = new RegExp(`data-testid="ops-counter-${testId}"[^>]*>([^<]*)<`).exec(markup);
  return match ? (match[1] ?? null) : null;
}

/** Slice out just the snapshot-counter section so assertions cannot be satisfied by other cards. */
function countersSection(markup: string): string {
  const start = markup.indexOf('data-testid="ops-snapshot-counters"');
  expect(start).toBeGreaterThan(-1);
  const end = markup.indexOf("<section", start);
  return markup.slice(start, end === -1 ? markup.length : end);
}

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "ops-snapshot-test-secret";
  const token = createSessionToken({
    email: "ops@fortexa.local",
    role: "operator",
    userId: "ops-snapshot-operator-id",
    expiresInSeconds: 120,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

async function metricsRouteBody(): Promise<MetricsSnapshot> {
  const response = await metricsRoute(
    new NextRequest("http://localhost/api/metrics", {
      headers: { cookie: operatorCookie() },
    })
  );
  return (await response.json()) as MetricsSnapshot;
}

describe("OpsDashboard metrics snapshot counters", () => {
  beforeEach(() => {
    resetMetrics();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the counters carried by the snapshot without fetching anything", () => {
    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("WARN");
    recordDecisionOutcome("BLOCK");
    recordRateLimitRejection();
    recordStellarSubmitResult("horizon_failure");

    const snapshot = getMetricsSnapshot();
    const markup = renderDashboard(snapshot);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readCounter(markup, "allow")).toBe(String(snapshot.counters.allow));
    expect(readCounter(markup, "deny")).toBe(String(snapshot.counters.deny));
    expect(readCounter(markup, "rate-limit")).toBe(String(snapshot.counters.rateLimit));
    expect(readCounter(markup, "submit-failures")).toBe(String(snapshot.counters.submitFailures));

    expect(snapshot.counters.allow).toBe(3);
    expect(snapshot.counters.deny).toBe(1);
    expect(snapshot.counters.rateLimit).toBe(1);
    expect(snapshot.counters.submitFailures).toBe(1);
  });

  it("renders the same counters the metrics route exports", async () => {
    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("WARN");
    recordDecisionOutcome("REQUIRE_APPROVAL");
    recordDecisionOutcome("BLOCK");
    recordRateLimitRejection();
    recordRateLimitRejection();
    recordStellarSubmitResult("source_wallet_mismatch");

    const snapshot = getMetricsSnapshot();
    const markup = renderDashboard(snapshot);
    const exported = await metricsRouteBody();

    expect(exported.counters).toEqual(snapshot.counters);
    expect(readCounter(markup, "allow")).toBe(String(exported.counters.allow));
    expect(readCounter(markup, "deny")).toBe(String(exported.counters.deny));
    expect(readCounter(markup, "rate-limit")).toBe(String(exported.counters.rateLimit));
    expect(readCounter(markup, "submit-failures")).toBe(String(exported.counters.submitFailures));
  });

  it("renders zeroes for an empty snapshot instead of a spinner", () => {
    const markup = renderDashboard(getMetricsSnapshot());

    const emptyCounters: Record<string, number> = {
      allow: 0,
      deny: 0,
      "rate-limit": 0,
      "submit-failures": 0,
    };

    for (const [testId, value] of Object.entries(emptyCounters)) {
      expect(readCounter(markup, testId)).toBe(String(value));
    }

    // The counter cards themselves never sit on a spinner, even though the
    // client-fetched cards next to them still show their initial loading state.
    expect(countersSection(markup)).not.toContain("Loading");
    expect(markup).toContain("Empty snapshot reads as zeroes.");
  });

  it("renders zeroes when the dashboard is rendered before any snapshot arrives", () => {
    const markup = renderDashboard();

    expect(readCounter(markup, "allow")).toBe("0");
    expect(readCounter(markup, "deny")).toBe("0");
    expect(readCounter(markup, "rate-limit")).toBe("0");
    expect(readCounter(markup, "submit-failures")).toBe("0");
  });

  it("changes both views when the snapshot changes", async () => {
    const before = renderDashboard(getMetricsSnapshot());
    const exportedBefore = await metricsRouteBody();

    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("BLOCK");
    recordRateLimitRejection();
    recordStellarSubmitResult("horizon_failure");

    const after = renderDashboard(getMetricsSnapshot());
    const exportedAfter = await metricsRouteBody();

    expect(exportedBefore.counters).toEqual({ allow: 0, deny: 0, rateLimit: 0, submitFailures: 0 });
    expect(exportedAfter.counters).toEqual({ allow: 1, deny: 1, rateLimit: 1, submitFailures: 1 });

    for (const testId of ["allow", "deny", "rate-limit", "submit-failures"] as const) {
      expect(readCounter(before, testId)).toBe("0");
      expect(readCounter(after, testId)).toBe("1");
    }
  });

  it("never scans the audit table for these four numbers", () => {
    recordDecisionOutcome("APPROVE");
    recordStellarSubmitResult("horizon_failure");

    const markup = renderDashboard(getMetricsSnapshot());

    // The signed-tx card is still labelled as coming from the audit export, but
    // none of the four counters can be attributed to it.
    expect(markup).toContain("From audit export");
    expect(readCounter(markup, "allow")).toBe("1");
    expect(readCounter(markup, "submit-failures")).toBe("1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
