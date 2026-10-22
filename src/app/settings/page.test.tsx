import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMetricsSnapshot,
  recordDecisionOutcome,
  recordRateLimitRejection,
  recordStellarSubmitResult,
  resetMetrics,
} from "@/lib/observability/metrics";
import type { MetricsSnapshot } from "@/lib/observability/metrics";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
  }),
}));

vi.mock("@/lib/storage/audit-store", () => ({
  listAuditEntries: async () => [],
}));

import SettingsPage from "@/app/settings/page";

async function renderOpsTab(): Promise<string> {
  // The page is an async server component: resolve it first, then render the tree.
  const page = await SettingsPage({ searchParams: Promise.resolve({ tab: "ops" }) });
  return renderToStaticMarkup(page);
}

function readCounter(markup: string, testId: string): string | null {
  const match = new RegExp(`data-testid="ops-counter-${testId}"[^>]*>([^<]*)<`).exec(markup);
  return match ? (match[1] ?? null) : null;
}

describe("/settings?tab=ops dashboard loader", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("passes the in-process metrics snapshot to the ops dashboard", async () => {
    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("WARN");
    recordDecisionOutcome("BLOCK");
    recordRateLimitRejection();
    recordStellarSubmitResult("horizon_failure");

    const snapshot: MetricsSnapshot = getMetricsSnapshot();
    const markup = await renderOpsTab();

    expect(readCounter(markup, "allow")).toBe(String(snapshot.counters.allow));
    expect(readCounter(markup, "deny")).toBe(String(snapshot.counters.deny));
    expect(readCounter(markup, "rate-limit")).toBe(String(snapshot.counters.rateLimit));
    expect(readCounter(markup, "submit-failures")).toBe(String(snapshot.counters.submitFailures));

    expect(snapshot.counters).toEqual({ allow: 2, deny: 1, rateLimit: 1, submitFailures: 1 });
  });

  it("renders zeroes when the process has recorded no activity", async () => {
    const markup = await renderOpsTab();

    expect(readCounter(markup, "allow")).toBe("0");
    expect(readCounter(markup, "deny")).toBe("0");
    expect(readCounter(markup, "rate-limit")).toBe("0");
    expect(readCounter(markup, "submit-failures")).toBe("0");
  });
});
