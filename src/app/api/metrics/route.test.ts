import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { AUTH_COOKIE_KEY, createSessionToken } from "@/lib/auth/session";
import {
  recordApiMetric,
  recordDecisionOutcome,
  recordRateLimitRejection,
  recordStellarSubmitResult,
  resetMetrics,
} from "@/lib/observability/metrics";
import { GET } from "@/app/api/metrics/route";

function operatorCookie() {
  process.env.FORTEXA_AUTH_SECRET = "metrics-test-secret";
  const token = createSessionToken({
    email: "ops@fortexa.local",
    role: "operator",
    userId: "metrics-operator-id",
    expiresInSeconds: 120,
  });
  return `${AUTH_COOKIE_KEY}=${token}`;
}

describe("/api/metrics route", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("returns 401 when unauthenticated", async () => {
    const request = new NextRequest("http://localhost/api/metrics");
    const response = await GET(request);
    expect(response.status).toBe(401);

    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Unauthorized. Login required.");
  });

  it("returns JSON shape with expected fields", async () => {
    const request = new NextRequest("http://localhost/api/metrics", {
      headers: { cookie: operatorCookie() },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as MetricsSnapshot;

    expect(body.service).toBe("fortexa");
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);

    expect(body.totals).toHaveProperty("totalCount");
    expect(body.totals).toHaveProperty("errorCount");
    expect(body.totals).toHaveProperty("errorRate");
    expect(typeof body.totals.totalCount).toBe("number");

    // The ops dashboard renders these exact fields.
    expect(body.counters).toEqual({ allow: 0, deny: 0, rateLimit: 0, submitFailures: 0 });

    expect(Array.isArray(body.routes)).toBe(true);

    for (const route of body.routes) {
      expect(route).toHaveProperty("route");
      expect(route).toHaveProperty("method");
      expect(route).toHaveProperty("totalCount");
      expect(route).toHaveProperty("errorCount");
      expect(route).toHaveProperty("errorRate");
      expect(route).toHaveProperty("p95DurationMs");
      expect(route).toHaveProperty("avgDurationMs");
      expect(route).toHaveProperty("lastStatusCode");
      expect(route).toHaveProperty("lastSeenAt");

      expect(typeof route.route).toBe("string");
      expect(typeof route.method).toBe("string");
      expect(typeof route.totalCount).toBe("number");
      expect(typeof route.errorCount).toBe("number");
      expect(typeof route.errorRate).toBe("number");
      expect(typeof route.p95DurationMs).toBe("number");
      expect(typeof route.lastSeenAt).toBe("string");
      expect(new Date(route.lastSeenAt).toISOString()).toBe(route.lastSeenAt);
    }
  });

  it("records the request itself in routes array", async () => {
    const request = new NextRequest("http://localhost/api/metrics", {
      headers: { cookie: operatorCookie() },
    });

    const response = await GET(request);
    const body = (await response.json()) as {
      routes: Array<{
        route: string;
        method: string;
        totalCount: number;
        errorCount: number;
        errorRate: number;
        p95DurationMs: number;
      }>;
    };

    const selfRoute = body.routes.find((r) => r.route === "/api/metrics");
    expect(selfRoute).toBeDefined();
    expect(selfRoute?.method).toBe("GET");
    expect(selfRoute?.totalCount).toBe(1);
    expect(selfRoute?.errorCount).toBe(0);
    expect(selfRoute?.errorRate).toBe(0);
    expect(selfRoute?.p95DurationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns Prometheus text format with required metrics", async () => {
    const request = new NextRequest("http://localhost/api/metrics?format=prometheus", {
      headers: { cookie: operatorCookie() },
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");

    const text = await response.text();

    expect(text).toContain("# HELP fortexa_requests_total Total API requests by route/method");
    expect(text).toContain("# TYPE fortexa_requests_total counter");
    expect(text).toContain("fortexa_requests_total{");

    expect(text).toContain("# HELP fortexa_request_errors_total Total API errors by route/method");
    expect(text).toContain("# TYPE fortexa_request_errors_total counter");
    expect(text).toContain("fortexa_request_errors_total{");

    expect(text).toContain(
      "# HELP fortexa_request_duration_ms_p95 P95 request duration in milliseconds"
    );
    expect(text).toContain("# TYPE fortexa_request_duration_ms_p95 gauge");
    expect(text).toContain("fortexa_request_duration_ms_p95{");

    // Every request-bucket series is labelled by route and method.
    const requestBucketFamilies = [
      "fortexa_requests_total",
      "fortexa_request_errors_total",
      "fortexa_request_duration_ms_p95",
    ];

    const lines = text.trim().split("\n");
    for (const line of lines) {
      if (
        line.startsWith("fortexa_requests_total{") ||
        line.startsWith("fortexa_request_errors_total{") ||
        line.startsWith("fortexa_request_duration_ms_p95{")
      ) {
        expect(line).toMatch(/route="[^"]+"/);
        expect(line).toMatch(/method="[^"]+"/);
      }
    }
  });

  it("emits allow, deny, and submit counters without destination labels or secrets", async () => {
    const destinationWallet = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";
    const fixtureSecret = "fixture-secret-must-not-leak";

    recordApiMetric({
      route: `/api/stellar/pay?destination=${destinationWallet}&memo=paid for coffee&error=${fixtureSecret}`,
      method: "POST",
      statusCode: 200,
      durationMs: 5,
    });
    recordApiMetric({
      route: `/api/stellar/pay/${destinationWallet}`,
      method: "POST",
      statusCode: 400,
      durationMs: 5,
    });
    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("BLOCK");
    recordRateLimitRejection();
    recordStellarSubmitResult("horizon_failure");

    const jsonResponse = await GET(
      new NextRequest("http://localhost/api/metrics", {
        headers: { cookie: operatorCookie() },
      })
    );
    const body = (await jsonResponse.json()) as MetricsSnapshot;

    expect(body.counters).toEqual({ allow: 1, deny: 1, rateLimit: 1, submitFailures: 1 });

    const prometheusResponse = await GET(
      new NextRequest("http://localhost/api/metrics?format=prometheus", {
        headers: { cookie: operatorCookie() },
      })
    );
    const text = await prometheusResponse.text();

    expect(text).toContain(`fortexa_decisions_allowed_total ${body.counters.allow}`);
    expect(text).toContain(`fortexa_decisions_denied_total ${body.counters.deny}`);
    expect(text).toContain(`fortexa_rate_limit_rejections_total ${body.counters.rateLimit}`);
    expect(text).toContain(`fortexa_stellar_submit_failures_total ${body.counters.submitFailures}`);
  });

  it("reports zeroed counters before any activity is recorded", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/metrics", {
        headers: { cookie: operatorCookie() },
      })
    );
    const body = (await response.json()) as MetricsSnapshot;

    expect(body.counters).toEqual({ allow: 0, deny: 0, rateLimit: 0, submitFailures: 0 });
  });

  it("returns 403 for viewer role", async () => {
    process.env.FORTEXA_AUTH_SECRET = "metrics-test-secret";
    const viewerToken = createSessionToken({
      email: "viewer@fortexa.local",
      role: "viewer",
      userId: "viewer-id",
      expiresInSeconds: 120,
    });
    const viewerCookie = `${AUTH_COOKIE_KEY}=${viewerToken}`;

    const request = new NextRequest("http://localhost/api/metrics", {
      headers: { cookie: viewerCookie },
    });

    const response = await GET(request);
    expect(response.status).toBe(403);
  });
});
