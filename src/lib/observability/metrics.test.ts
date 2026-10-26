import { beforeEach, describe, expect, it } from "vitest";

import {
  ALLOWED_LABEL_KEYS,
  ALLOWED_METRIC_NAMES,
  ALLOWED_METHODS,
  ALLOWED_OUTCOMES,
  ALLOWED_RESULTS,
  ALLOWED_ROUTES,
  ALLOW_OUTCOMES,
  DENY_OUTCOMES,
  MAX_CARDINALITY,
  SUBMIT_FAILURE_RESULTS,
  escapePrometheusLabelValue,
  getDecisionOutcomeCounts,
  getMetricsSnapshot,
  getOpsCounters,
  getRateLimitRejectionCount,
  getStellarSubmitResultCounts,
  isAllowedLabelKey,
  isAllowedMetricName,
  normalizeMethod,
  normalizeRoute,
  recordApiMetric,
  recordDecisionOutcome,
  recordRateLimitRejection,
  recordStellarSubmitResult,
  renderHelpLine,
  renderMetricLine,
  renderTypeLine,
  resetMetrics,
  toPrometheusText,
} from "@/lib/observability/metrics";

describe("observability metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("tracks request counters and error rate", () => {
    recordApiMetric({ route: "/api/decision", method: "POST", statusCode: 200, durationMs: 40 });
    recordApiMetric({ route: "/api/decision", method: "POST", statusCode: 500, durationMs: 80 });

    const snapshot = getMetricsSnapshot();
    const routeMetric = snapshot.routes.find((route) => route.route === "/api/decision");

    expect(routeMetric).toBeDefined();
    expect(routeMetric?.totalCount).toBe(2);
    expect(routeMetric?.errorCount).toBe(1);
    expect(routeMetric?.errorRate).toBe(0.5);
    expect(routeMetric?.p95DurationMs).toBe(80);
  });

  it("renders prometheus text output", () => {
    recordApiMetric({ route: "/api/policy", method: "GET", statusCode: 200, durationMs: 20 });

    const output = toPrometheusText();

    expect(output).toContain("fortexa_requests_total");
    expect(output).toContain('route="/api/policy"');
  });

  it("increments decision outcome counters (success path)", () => {
    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("APPROVE");
    recordDecisionOutcome("WARN");

    const counts = getDecisionOutcomeCounts();
    expect(counts.get("APPROVE")).toBe(2);
    expect(counts.get("WARN")).toBe(1);
    expect(counts.get("REQUIRE_APPROVAL")).toBeUndefined();
    expect(counts.get("BLOCK")).toBeUndefined();
  });

  it("increments decision outcome counters (failure path)", () => {
    recordDecisionOutcome("BLOCK");

    const counts = getDecisionOutcomeCounts();
    expect(counts.get("BLOCK")).toBe(1);
    expect(counts.get("APPROVE")).toBeUndefined();
  });

  it("increments stellar submit result counters (success path)", () => {
    recordStellarSubmitResult("success");
    recordStellarSubmitResult("success");
    recordStellarSubmitResult("idempotency_replay");

    const counts = getStellarSubmitResultCounts();
    expect(counts.get("success")).toBe(2);
    expect(counts.get("idempotency_replay")).toBe(1);
    expect(counts.get("horizon_failure")).toBeUndefined();
  });

  it("increments stellar submit result counters (failure path)", () => {
    recordStellarSubmitResult("horizon_failure");
    recordStellarSubmitResult("idempotency_conflict");

    const counts = getStellarSubmitResultCounts();
    expect(counts.get("horizon_failure")).toBe(1);
    expect(counts.get("idempotency_conflict")).toBe(1);
    expect(counts.get("success")).toBeUndefined();
  });

  it("includes new counters in prometheus text output", () => {
    recordDecisionOutcome("APPROVE");
    recordStellarSubmitResult("success");

    const output = toPrometheusText();
    expect(output).toContain("fortexa_decision_outcomes_total");
    expect(output).toContain('outcome="APPROVE"');
    expect(output).toContain("fortexa_stellar_submit_results_total");
    expect(output).toContain('result="success"');
  });

  it("resets new counters alongside existing buckets", () => {
    recordDecisionOutcome("WARN");
    recordStellarSubmitResult("success");
    recordRateLimitRejection();
    resetMetrics();

    expect(getDecisionOutcomeCounts().size).toBe(0);
    expect(getStellarSubmitResultCounts().size).toBe(0);
    expect(getRateLimitRejectionCount()).toBe(0);
  });

  describe("ops counters (dashboard <-> metrics parity)", () => {
    it("zeroes every counter for an empty snapshot", () => {
      expect(getMetricsSnapshot().counters).toEqual({
        allow: 0,
        deny: 0,
        rateLimit: 0,
        submitFailures: 0,
      });
    });

    it("rolls allow/deny decisions up by outcome", () => {
      recordDecisionOutcome("APPROVE");
      recordDecisionOutcome("WARN");
      recordDecisionOutcome("REQUIRE_APPROVAL");
      recordDecisionOutcome("BLOCK");

      expect(getOpsCounters().allow).toBe(2);
      expect(getOpsCounters().deny).toBe(2);
    });

    it("counts rate-limit rejections", () => {
      recordRateLimitRejection();
      recordRateLimitRejection();
      recordRateLimitRejection();

      expect(getRateLimitRejectionCount()).toBe(3);
      expect(getMetricsSnapshot().counters.rateLimit).toBe(3);
    });

    it("counts submit failures but treats replays and successes as non-failures", () => {
      recordStellarSubmitResult("success");
      recordStellarSubmitResult("idempotency_replay");
      for (const result of SUBMIT_FAILURE_RESULTS) {
        recordStellarSubmitResult(result);
      }

      expect(getMetricsSnapshot().counters.submitFailures).toBe(SUBMIT_FAILURE_RESULTS.length);
      expect(SUBMIT_FAILURE_RESULTS).not.toContain("success");
      expect(SUBMIT_FAILURE_RESULTS).not.toContain("idempotency_replay");
    });

    it("never derives counters from request buckets", () => {
      recordApiMetric({ route: "/api/decision", method: "POST", statusCode: 429, durationMs: 5 });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.totals.errorCount).toBe(1);
      expect(snapshot.counters).toEqual({
        allow: 0,
        deny: 0,
        rateLimit: 0,
        submitFailures: 0,
      });
    });

    it("exposes the same numbers through the JSON snapshot and the prometheus body", () => {
      recordDecisionOutcome("APPROVE");
      recordDecisionOutcome("BLOCK");
      recordRateLimitRejection();
      recordStellarSubmitResult("idempotency_conflict");

      const { counters } = getMetricsSnapshot();
      const output = toPrometheusText();

      expect(output).toContain(`fortexa_decisions_allowed_total ${counters.allow}`);
      expect(output).toContain(`fortexa_decisions_denied_total ${counters.deny}`);
      expect(output).toContain(`fortexa_rate_limit_rejections_total ${counters.rateLimit}`);
      expect(output).toContain(`fortexa_stellar_submit_failures_total ${counters.submitFailures}`);
      expect(output).toContain("# TYPE fortexa_decisions_allowed_total counter");
      expect(output).toContain("# TYPE fortexa_decisions_denied_total counter");
      expect(output).toContain("# TYPE fortexa_rate_limit_rejections_total counter");
      expect(output).toContain("# TYPE fortexa_stellar_submit_failures_total counter");
    });

    it("emits zero-initialised counters so alerts never break on a fresh process", () => {
      const output = toPrometheusText();

      expect(output).toContain("fortexa_decisions_allowed_total 0");
      expect(output).toContain("fortexa_decisions_denied_total 0");
      expect(output).toContain("fortexa_rate_limit_rejections_total 0");
      expect(output).toContain("fortexa_stellar_submit_failures_total 0");
    });

    it("keeps allow/deny groups aligned with the exported outcome allowlist", () => {
      expect(ALLOW_OUTCOMES.every((outcome) => ALLOWED_OUTCOMES.has(outcome))).toBe(true);
      expect(DENY_OUTCOMES.every((outcome) => ALLOWED_OUTCOMES.has(outcome))).toBe(true);
      expect(new Set([...ALLOW_OUTCOMES, ...DENY_OUTCOMES]).size).toBe(ALLOWED_OUTCOMES.size);
      expect(SUBMIT_FAILURE_RESULTS.every((result) => ALLOWED_RESULTS.has(result))).toBe(true);
    });
  });

  describe("#205 redaction-aware metrics", () => {
    it("does not place Stellar addresses or memos in route labels", () => {
      const destination = "GA7QYNF7SOWQ3GLR2ZGMGIRKJ7F6NCWKUX6PS7LJVCUJUJQG2U5F6Z7P";
      recordApiMetric({
        route: `/api/decision?destination=${destination}&memo=invoice-8817`,
        method: "POST",
        statusCode: 500,
        durationMs: 10,
      });
      recordApiMetric({
        route: `memo ${destination} failed`,
        method: "POST",
        statusCode: 500,
        durationMs: 10,
      });

      const output = toPrometheusText();
      expect(output).not.toContain(destination);
      expect(output).not.toContain("invoice-8817");

      const snapshot = getMetricsSnapshot();
      for (const r of snapshot.routes) {
        expect(r.route).not.toContain(destination);
        expect(r.route).not.toContain("invoice-8817");
        expect(ALLOWED_ROUTES.has(r.route)).toBe(true);
      }
    });

    it("keeps incrementing submit failure counters when errors are fully redacted", () => {
      const signedXdr = "A".repeat(120);

      // Horizon failure whose message is entirely a signed XDR blob: logging
      // redacts it, but the stable counter must still move.
      recordStellarSubmitResult("horizon_failure");
      recordStellarSubmitResult("horizon_failure");
      recordStellarSubmitResult("validation_failure");

      const counts = getStellarSubmitResultCounts();
      expect(counts.get("horizon_failure")).toBe(2);
      expect(counts.get("validation_failure")).toBe(1);
      expect(signedXdr.length).toBe(120); // fixture sanity

      const output = toPrometheusText();
      expect(output).toContain('result="horizon_failure"');
      expect(output).not.toContain(signedXdr);
    });

    it("keeps decision outcome counters incrementing when errors are redacted", () => {
      recordDecisionOutcome("BLOCK");
      recordDecisionOutcome("BLOCK");
      recordDecisionOutcome("REQUIRE_APPROVAL");

      const counts = getDecisionOutcomeCounts();
      expect(counts.get("BLOCK")).toBe(2);
      expect(counts.get("REQUIRE_APPROVAL")).toBe(1);
    });

    it("never emits metric label values longer than route allowlist entries", () => {
      const longBlob = "x".repeat(300);
      recordApiMetric({ route: longBlob, method: "POST", statusCode: 200, durationMs: 5 });
      recordApiMetric({ route: `/api/decision?xdr=${longBlob}`, method: "POST", statusCode: 200, durationMs: 5 });

      const snapshot = getMetricsSnapshot();
      for (const r of snapshot.routes) {
        expect(r.route.length).toBeLessThanOrEqual(128);
        expect(r.route).not.toContain(longBlob);
      }
    });
  });

  describe("allowlist and normalization (SCF high)", () => {
    it("defines a fixed allowlist of low-cardinality routes and methods", () => {
      expect(ALLOWED_ROUTES.has("/api/decision")).toBe(true);
      expect(ALLOWED_ROUTES.has("/api/stellar/submit-signed")).toBe(true);
      expect(ALLOWED_ROUTES.has("/api/metrics")).toBe(true);
      expect(ALLOWED_ROUTES.has("/other")).toBe(true);
      expect(ALLOWED_METHODS.has("GET")).toBe(true);
      expect(ALLOWED_METHODS.has("POST")).toBe(true);
      expect(ALLOWED_OUTCOMES.has("APPROVE")).toBe(true);
      expect(ALLOWED_RESULTS.has("success")).toBe(true);
    });

    it("normalizes unknown routes to /other", () => {
      expect(normalizeRoute("/api/unknown-route")).toBe("/other");
      expect(normalizeRoute("/random/path")).toBe("/other");
      expect(normalizeRoute("")).toBe("/other");
      expect(normalizeRoute("/api/decision/")).toBe("/api/decision");
    });

    it("drops wallet addresses from route labels", () => {
      const wallet = "G" + "A".repeat(55);
      // Test with a correctly formed Stellar address (G + 55 chars in base32)
      const stellarWallet = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";
      expect(stellarWallet.length).toBe(56);
      recordApiMetric({ route: `/api/decision?wallet=${stellarWallet}`, method: "POST", statusCode: 200, durationMs: 10 });
      recordApiMetric({ route: `/api/stellar/submit-signed/${stellarWallet}`, method: "POST", statusCode: 200, durationMs: 10 });
      recordApiMetric({ route: stellarWallet, method: "POST", statusCode: 200, durationMs: 10 });

      const snapshot = getMetricsSnapshot();
      const routes = snapshot.routes.map((r) => r.route);
      // No raw wallet should appear as a label
      for (const r of routes) {
        expect(r).not.toContain(stellarWallet);
        expect(r).not.toContain(wallet);
      }
      // Wallet-containing inputs should collapse to /other, query strings are stripped so wallet not leaked
      expect(normalizeRoute(stellarWallet)).toBe("/other");
      expect(normalizeRoute(`/api/decision?wallet=${stellarWallet}`)).toBe("/api/decision");
      expect(normalizeRoute(`/api/stellar/submit-signed/${stellarWallet}`)).toBe("/other");
    });

    it("drops free-text and request values from route labels", () => {
      recordApiMetric({ route: "free text with spaces", method: "POST", statusCode: 200, durationMs: 10 });
      recordApiMetric({ route: 'injection"quote', method: "POST", statusCode: 200, durationMs: 10 });
      recordApiMetric({ route: "a".repeat(200), method: "POST", statusCode: 200, durationMs: 10 });
      recordApiMetric({ route: "/api/decision?memo=hello world&amount=100", method: "POST", statusCode: 200, durationMs: 10 });

      const snapshot = getMetricsSnapshot();
      for (const r of snapshot.routes) {
        expect(r.route).not.toContain(" ");
        expect(r.route).not.toContain('"');
        expect(r.route.length).toBeLessThanOrEqual(128);
      }
      expect(normalizeRoute("free text with spaces")).toBe("/other");
      expect(normalizeRoute('injection"quote')).toBe("/other");
      expect(normalizeRoute("a".repeat(200))).toBe("/other");
    });

    it("normalizes method to allowlist and uses UNKNOWN for disallowed verbs", () => {
      expect(normalizeMethod("post")).toBe("POST");
      expect(normalizeMethod("GeT")).toBe("GET");
      expect(normalizeMethod("WALLET")).toBe("UNKNOWN");
      expect(normalizeMethod("PURGE")).toBe("UNKNOWN");
      expect(normalizeMethod("")).toBe("UNKNOWN");
    });

    it("drops disallowed decision outcomes and stellar results", () => {
      // @ts-expect-error: testing runtime guard for invalid outcome
      recordDecisionOutcome("G" + "A".repeat(55));
      // @ts-expect-error: testing freetext injection guard
      recordDecisionOutcome("APPROVE; wallet=G123");
      // @ts-expect-error invalid outcome
      recordDecisionOutcome("free-text");
      // @ts-expect-error invalid result
      recordStellarSubmitResult("wallet_leak_payload");
      // @ts-expect-error invalid result format
      recordStellarSubmitResult("G12345");

      expect(getDecisionOutcomeCounts().size).toBe(0);
      expect(getStellarSubmitResultCounts().size).toBe(0);

      // Allowed values still work
      recordDecisionOutcome("APPROVE");
      recordStellarSubmitResult("success");
      expect(getDecisionOutcomeCounts().get("APPROVE")).toBe(1);
      expect(getStellarSubmitResultCounts().get("success")).toBe(1);
    });
  });

  describe("redaction", () => {
    it("never exposes wallet addresses in prometheus text", () => {
      const wallet = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";
      recordApiMetric({ route: wallet, method: "POST", statusCode: 200, durationMs: 10 });
      recordApiMetric({ route: `/api/decision?wallet=${wallet}`, method: "POST", statusCode: 200, durationMs: 10 });
      // Also try to inject via outcome/result with wallet-like string (should be dropped)
      // @ts-expect-error wallet injection attempt
      recordDecisionOutcome(wallet);
      // @ts-expect-error wallet injection attempt
      recordStellarSubmitResult(wallet);

      const output = toPrometheusText();
      expect(output).not.toContain(wallet);
      expect(output).not.toContain("GA5Z");
    });

    it("escapes prometheus label values", () => {
      expect(escapePrometheusLabelValue('a"b')).toBe('a\\"b');
      expect(escapePrometheusLabelValue("a\\b")).toBe("a\\\\b");
      expect(escapePrometheusLabelValue("a\nb")).toBe("a\\nb");
      expect(escapePrometheusLabelValue("/api/decision")).toBe("/api/decision");
    });

    it("prometheus output only contains allowlisted label values", () => {
      recordApiMetric({ route: "/api/decision", method: "POST", statusCode: 200, durationMs: 10 });
      recordApiMetric({ route: "/api/unknown", method: "POST", statusCode: 200, durationMs: 10 });
      recordDecisionOutcome("APPROVE");
      recordStellarSubmitResult("success");

      const output = toPrometheusText();
      // Extract route labels
      const routeLabels = [...output.matchAll(/route="([^"]+)"/g)].map((m) => m[1]);
      for (const label of routeLabels) {
        // After escaping, unescaped value should be in allowlist
        const unescaped = label.replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
        expect(ALLOWED_ROUTES.has(unescaped)).toBe(true);
      }
      const outcomeLabels = [...output.matchAll(/outcome="([^"]+)"/g)].map((m) => m[1]);
      for (const label of outcomeLabels) {
        expect(ALLOWED_OUTCOMES.has(label as never)).toBe(true);
      }
      const resultLabels = [...output.matchAll(/result="([^"]+)"/g)].map((m) => m[1]);
      for (const label of resultLabels) {
        expect(ALLOWED_RESULTS.has(label as never)).toBe(true);
      }
    });
  });

  describe("redacting exporter", () => {
    const wallet = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";
    const secret = "super-secret-error-token-9f2a";

    type FixtureSeries = { name: string; labels: Record<string, string>; value: number };

    function exportFixture(series: FixtureSeries[]): string {
      const lines = series
        .map((fixture) => renderMetricLine(fixture.name, fixture.labels, fixture.value))
        .filter((line): line is string => line !== null);
      return lines.length > 0 ? `${lines.join("\n")}\n` : "";
    }

    it("only emits documented metric names", () => {
      recordApiMetric({ route: "/api/decision", method: "POST", statusCode: 200, durationMs: 10 });
      recordDecisionOutcome("APPROVE");
      recordStellarSubmitResult("success");

      const output = toPrometheusText();
      const names = output
        .split("\n")
        .map((line) => {
          if (line.startsWith("# HELP ") || line.startsWith("# TYPE ")) {
            return line.split(" ")[2];
          }
          if (line.startsWith("fortexa_")) {
            return line.split(/[{ ]/)[0];
          }
          return null;
        })
        .filter((name): name is string => name !== null);

      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(ALLOWED_METRIC_NAMES.has(name)).toBe(true);
      }
      expect(isAllowedMetricName("fortexa_requests_total")).toBe(true);
      expect(isAllowedMetricName("fortexa_payment_destination_total")).toBe(false);
    });

    it("drops a destination label in the fixture from the body", () => {
      const fixture: FixtureSeries[] = [
        { name: "fortexa_requests_total", labels: { route: "/api/stellar/pay", method: "POST" }, value: 3 },
        {
          name: "fortexa_requests_total",
          labels: { route: "/api/stellar/pay", method: "POST", destination: wallet },
          value: 1,
        },
        {
          name: "fortexa_decision_outcomes_total",
          labels: { outcome: "APPROVE", memo: "coffee beans" },
          value: 2,
        },
      ];

      const body = exportFixture(fixture);

      expect(body).toContain('route="/api/stellar/pay"');
      expect(body).not.toContain("destination");
      expect(body).not.toContain(wallet);
      expect(body).not.toContain("memo");
      expect(body).not.toContain("coffee");
    });

    it("rejects metric names outside the documented set", () => {
      expect(renderMetricLine("fortexa_payment_destination_total", { route: "/api/stellar/pay" }, 1)).toBeNull();
      expect(renderHelpLine("fortexa_secret_errors_total", "Total secret errors")).toBeNull();
      expect(renderTypeLine("fortexa_secret_errors_total", "counter")).toBeNull();
    });

    it("rejects label keys outside the documented set", () => {
      expect(isAllowedLabelKey("route")).toBe(true);
      expect(isAllowedLabelKey("outcome")).toBe(true);
      expect(isAllowedLabelKey("destination")).toBe(false);
      expect(isAllowedLabelKey("memo")).toBe(false);

      expect(renderMetricLine("fortexa_requests_total", { route: "/api/decision", destination: wallet }, 1)).toBeNull();
      expect(renderMetricLine("fortexa_decision_outcomes_total", { outcome: "APPROVE", memo: "hi" }, 1)).toBeNull();
      expect(renderMetricLine("fortexa_requests_total", { route: "/api/decision", method: "GET" }, 1)).not.toBeNull();
    });

    it("redacts secret-bearing error text before it is appended to a help line", () => {
      const help = renderHelpLine(
        "fortexa_requests_total",
        `Total API requests by route/method; last error token=${secret} wallet=${wallet}`
      );

      expect(help).not.toBeNull();
      expect(help).not.toContain(secret);
      expect(help).not.toContain(wallet);
      expect(help).toContain("[REDACTED]");
      expect(help).toContain("# HELP fortexa_requests_total");
    });

    it("emits allow, deny, and submit counters", () => {
      recordDecisionOutcome("APPROVE");
      recordDecisionOutcome("BLOCK");
      recordStellarSubmitResult("success");

      const output = toPrometheusText();
      expect(output).toContain("fortexa_decision_outcomes_total");
      expect(output).toContain('outcome="APPROVE"');
      expect(output).toContain('outcome="BLOCK"');
      expect(output).toContain("fortexa_stellar_submit_results_total");
      expect(output).toContain('result="success"');
    });

    it("exposes only the documented label key set", () => {
      expect([...ALLOWED_LABEL_KEYS].sort()).toEqual(["method", "outcome", "result", "route"]);
    });
  });

  describe("cardinality regression", () => {
    it("collapses unbounded wallet routes to a bounded number of series", () => {
      const baseWallet = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";
      for (let i = 0; i < 200; i++) {
        // Simulate attacker creating 200 unique wallet-like routes
        const walletVariant = `G${String(i).padStart(55, "A")}`;
        recordApiMetric({ route: `/api/decision?wallet=${walletVariant}`, method: "POST", statusCode: 200, durationMs: 10 });
        recordApiMetric({ route: `/tmp/request-${i}-${baseWallet}-${i}`, method: "POST", statusCode: 200, durationMs: 10 });
        recordApiMetric({ route: `free text payment ${i} for ${walletVariant}`, method: "POST", statusCode: 200, durationMs: 10 });
      }

      const snapshot = getMetricsSnapshot();
      // All attacker-controlled routes collapse to /other, so number of series stays low
      expect(snapshot.routes.length).toBeLessThanOrEqual(5);
      expect(snapshot.routes.length).toBeGreaterThan(0);
      // No high-cardinality wallet strings in snapshot
      for (const r of snapshot.routes) {
        expect(r.route).not.toMatch(/G[A-Z2-7]{55}/);
        expect(ALLOWED_ROUTES.has(r.route)).toBe(true);
      }
    });

    it("enforces MAX_CARDINALITY cap for distinct series", () => {
      // Feed many distinct allowed routes with distinct methods (up to limit)
      // Since allowlist collapses unknowns to /other, the only way to grow cardinality
      // is via allowed routes. Verify that snapshot never exceeds MAX_CARDINALITY
      // even when an attacker tries to create many series via method variation.
      const wallet = "GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR";
      for (let i = 0; i < 300; i++) {
        // Use wallet in route – should collapse to /other, not create new series
        recordApiMetric({ route: `/attack/${i}/${wallet}`, method: `METHOD${i}`, statusCode: 200, durationMs: 10 });
      }
      // Also record all legitimate routes
      for (const route of ALLOWED_ROUTES) {
        for (const method of ALLOWED_METHODS) {
          recordApiMetric({ route, method, statusCode: 200, durationMs: 10 });
        }
      }
      const snapshot = getMetricsSnapshot();
      expect(snapshot.routes.length).toBeLessThanOrEqual(MAX_CARDINALITY);
      // Every route in snapshot must be from allowlist
      for (const r of snapshot.routes) {
        expect(ALLOWED_ROUTES.has(r.route)).toBe(true);
      }
    });
  });
});
