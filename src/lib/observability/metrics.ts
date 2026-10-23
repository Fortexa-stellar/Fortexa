import { redactMetricText } from "@/lib/observability/redact";

type MetricKey = `${string}:${string}`;

export type DecisionOutcome = "APPROVE" | "WARN" | "REQUIRE_APPROVAL" | "BLOCK";
export type StellarSubmitResult =
  | "success"
  | "horizon_failure"
  | "validation_failure"
  | "idempotency_replay"
  | "idempotency_conflict"
  | "source_wallet_mismatch"
  | "signer_wallet_mismatch";

export const ALLOWED_ROUTES = new Set<string>([
  "/api/auth/challenge",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/refresh",
  "/api/auth/session",
  "/api/auth/wallet/revoke",
  "/api/decision",
  "/api/policy",
  "/api/policy/history",
  "/api/policy/validate",
  "/api/policy/simulate",
  "/api/policy/rollback",
  "/api/policy/rollback/preview",
  "/api/agent/plan",
  "/api/health",
  "/api/metrics",
  "/api/stellar/balance",
  "/api/stellar/build-payment",
  "/api/stellar/fund",
  "/api/stellar/pay",
  "/api/stellar/setup",
  "/api/stellar/submit-signed",
  "/api/audit",
  "/api/audit/export",
  "/api/audit/integrity",
  "/other",
]);

export const ALLOWED_METHODS = new Set<string>([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);

export const ALLOWED_OUTCOMES: ReadonlySet<DecisionOutcome> = new Set<DecisionOutcome>([
  "APPROVE",
  "WARN",
  "REQUIRE_APPROVAL",
  "BLOCK",
]);

export const ALLOWED_RESULTS: ReadonlySet<StellarSubmitResult> = new Set<StellarSubmitResult>([
  "success",
  "horizon_failure",
  "validation_failure",
  "idempotency_replay",
  "idempotency_conflict",
  "source_wallet_mismatch",
]);

/**
 * Aggregated enforcement counters.
 *
 * `allow`/`deny` mirror how `POST /api/decision` treats an outcome: APPROVE and
 * WARN let the action proceed (usage is consumed), REQUIRE_APPROVAL and BLOCK stop
 * it. `rateLimit` counts requests the rate limiter rejected before any handler
 * work ran, and `submitFailures` counts every signed-submission result that did
 * not settle on-chain (`idempotency_replay` is a successful no-op, so it is not
 * a failure).
 *
 * Both `getMetricsSnapshot()` consumers (the `/api/metrics` body and the ops
 * dashboard loader) read this one object, so the screen and the scrape cannot
 * disagree about these numbers.
 */
export type OpsCounters = {
  allow: number;
  deny: number;
  rateLimit: number;
  submitFailures: number;
};

export const ALLOW_OUTCOMES: readonly DecisionOutcome[] = ["APPROVE", "WARN"];
export const DENY_OUTCOMES: readonly DecisionOutcome[] = ["REQUIRE_APPROVAL", "BLOCK"];
export const SUBMIT_FAILURE_RESULTS: readonly StellarSubmitResult[] = [
  "horizon_failure",
  "validation_failure",
  "idempotency_conflict",
  "source_wallet_mismatch",
];

/**
 * Maximum distinct route+method series before new series are dropped.
 * This is a second-layer guard: primary guard is the allowlist which
 * collapses arbitrary user-controlled values to "/other".
 * Set to accommodate all legitimate route×method combinations (ALLOWED_ROUTES × ALLOWED_METHODS)
 * while still bounding explosion if the allowlist is misconfigured.
 */
export const MAX_CARDINALITY = 200;

/**
 * Documented metric names (see docs/observability.md). Anything else is
 * rejected by the exporter: series names must never carry payment data
 * (destination, memo, wallet) or attacker-controlled free text.
 */
export const ALLOWED_METRIC_NAMES: ReadonlySet<string> = new Set<string>([
  "fortexa_requests_total",
  "fortexa_request_errors_total",
  "fortexa_request_duration_ms_p95",
  "fortexa_decision_outcomes_total",
  "fortexa_stellar_submit_results_total",
]);

/**
 * The only label keys allowed on an exported series. In particular
 * `destination` and `memo` are rejected: they leak payment data and
 * blow up cardinality.
 */
export const ALLOWED_LABEL_KEYS: ReadonlySet<string> = new Set<string>([
  "route",
  "method",
  "outcome",
  "result",
]);

export function isAllowedMetricName(name: string): boolean {
  return typeof name === "string" && ALLOWED_METRIC_NAMES.has(name);
}

export function isAllowedLabelKey(key: string): boolean {
  return typeof key === "string" && ALLOWED_LABEL_KEYS.has(key);
}

const decisionOutcomeCounts = new Map<DecisionOutcome, number>();
const stellarSubmitResultCounts = new Map<StellarSubmitResult, number>();
let rateLimitRejections = 0;

type MetricBucket = {
  route: string;
  method: string;
  totalCount: number;
  errorCount: number;
  totalDurationMs: number;
  durationsMs: number[];
  lastStatusCode: number;
  lastSeenAt: string;
};

const buckets = new Map<MetricKey, MetricBucket>();
const MAX_DURATIONS = 500;

const WALLET_PATTERN = /G[A-Z2-7]{55}/;
const FREE_TEXT_PATTERN = /[\s\n\r\t"'`]/;

export function normalizeRoute(route: string): string {
  if (!route || typeof route !== "string") {
    return "/other";
  }
  // Strip query string and hash fragment – those can contain free-text / wallet data
  let normalized = route.trim().split("?")[0].split("#")[0] ?? "";
  // Remove trailing slash (except root)
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  // Drop overly long values (likely free-text injection)
  if (normalized.length === 0 || normalized.length > 128) {
    return "/other";
  }
  // Drop values containing Stellar wallet addresses
  if (WALLET_PATTERN.test(normalized)) {
    return "/other";
  }
  // Drop values containing whitespace/quotes (free-text)
  if (FREE_TEXT_PATTERN.test(normalized)) {
    return "/other";
  }
  // Only allow explicitly listed routes; everything else collapses to /other
  if (ALLOWED_ROUTES.has(normalized)) {
    return normalized;
  }
  return "/other";
}

export function normalizeMethod(method: string): string {
  if (!method || typeof method !== "string") {
    return "UNKNOWN";
  }
  const upper = method.trim().toUpperCase();
  if (ALLOWED_METHODS.has(upper)) {
    return upper;
  }
  return "UNKNOWN";
}

export function escapePrometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function keyOf(route: string, method: string): MetricKey {
  return `${method.toUpperCase()}:${route}`;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function recordApiMetric(input: {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
}) {
  const sanitizedRoute = normalizeRoute(input.route);
  const sanitizedMethod = normalizeMethod(input.method);
  const key = keyOf(sanitizedRoute, sanitizedMethod);

  // Cardinality guard: drop new series once MAX_CARDINALITY is reached
  if (!buckets.has(key) && buckets.size >= MAX_CARDINALITY) {
    return;
  }

  const current = buckets.get(key) ?? {
    route: sanitizedRoute,
    method: sanitizedMethod,
    totalCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
    durationsMs: [],
    lastStatusCode: 0,
    lastSeenAt: new Date().toISOString(),
  };

  current.totalCount += 1;
  current.totalDurationMs += input.durationMs;
  current.lastStatusCode = input.statusCode;
  current.lastSeenAt = new Date().toISOString();

  if (input.statusCode >= 400) {
    current.errorCount += 1;
  }

  current.durationsMs.push(input.durationMs);
  if (current.durationsMs.length > MAX_DURATIONS) {
    current.durationsMs.splice(0, current.durationsMs.length - MAX_DURATIONS);
  }

  buckets.set(key, current);
}

function sumCounter<TKey>(counts: ReadonlyMap<TKey, number>, keys: readonly TKey[]): number {
  return keys.reduce((total, key) => total + (counts.get(key) ?? 0), 0);
}

/**
 * Roll the low-cardinality counters up into the four numbers operators act on.
 * Every field is derived from in-process counters only — never from a scan of
 * the audit store — so it is safe to render on a dashboard and to alert on.
 */
export function getOpsCounters(): OpsCounters {
  return {
    allow: sumCounter(decisionOutcomeCounts, ALLOW_OUTCOMES),
    deny: sumCounter(decisionOutcomeCounts, DENY_OUTCOMES),
    rateLimit: rateLimitRejections,
    submitFailures: sumCounter(stellarSubmitResultCounts, SUBMIT_FAILURE_RESULTS),
  };
}

export type MetricsSnapshot = ReturnType<typeof getMetricsSnapshot>;

export function getMetricsSnapshot() {
  const byRoute = Array.from(buckets.values()).map((bucket) => {
    const avgDurationMs = bucket.totalCount > 0 ? bucket.totalDurationMs / bucket.totalCount : 0;
    const p95DurationMs = percentile(bucket.durationsMs, 95);
    const errorRate = bucket.totalCount > 0 ? bucket.errorCount / bucket.totalCount : 0;

    return {
      route: bucket.route,
      method: bucket.method,
      totalCount: bucket.totalCount,
      errorCount: bucket.errorCount,
      errorRate,
      avgDurationMs,
      p95DurationMs,
      lastStatusCode: bucket.lastStatusCode,
      lastSeenAt: bucket.lastSeenAt,
    };
  });

  const totals = byRoute.reduce(
    (accumulator, current) => {
      accumulator.totalCount += current.totalCount;
      accumulator.errorCount += current.errorCount;
      return accumulator;
    },
    { totalCount: 0, errorCount: 0 }
  );

  return {
    service: "fortexa",
    timestamp: new Date().toISOString(),
    totals: {
      ...totals,
      errorRate: totals.totalCount > 0 ? totals.errorCount / totals.totalCount : 0,
    },
    counters: getOpsCounters(),
    routes: byRoute,
  };
}

export function renderHelpLine(name: string, helpText: string): string | null {
  if (!isAllowedMetricName(name)) {
    return null;
  }
  return `# HELP ${name} ${redactMetricText(helpText)}`;
}

export function renderTypeLine(name: string, type: "counter" | "gauge"): string | null {
  if (!isAllowedMetricName(name)) {
    return null;
  }
  return `# TYPE ${name} ${type}`;
}

export function renderMetricLine(
  name: string,
  labels: Record<string, string>,
  value: string | number
): string | null {
  if (!isAllowedMetricName(name)) {
    return null;
  }
  const keys = Object.keys(labels);
  for (const key of keys) {
    if (!isAllowedLabelKey(key)) {
      return null;
    }
  }
  const renderedLabels = keys
    .map((key) => `${key}="${escapePrometheusLabelValue(String(labels[key]))}"`)
    .join(",");
  return `${name}{${renderedLabels}} ${value}`;
}

export function toPrometheusText() {
  const snapshot = getMetricsSnapshot();
  const lines: string[] = [];

  const push = (...candidates: Array<string | null>) => {
    for (const line of candidates) {
      if (line !== null) {
        lines.push(line);
      }
    }
  };

  push(renderHelpLine("fortexa_requests_total", "Total API requests by route/method"));
  push(renderTypeLine("fortexa_requests_total", "counter"));
  for (const route of snapshot.routes) {
    push(
      renderMetricLine(
        "fortexa_requests_total",
        { route: route.route, method: route.method },
        route.totalCount
      )
    );
  }

  // Rolled-up enforcement counters. These are always emitted (zero-initialised) so
  // alerting rules and Grafana panels stay valid on a freshly started process, and
  // so the scrape reports exactly the numbers the ops dashboard renders.
  lines.push("# HELP fortexa_decisions_allowed_total Total decisions that were allowed to proceed");
  lines.push("# TYPE fortexa_decisions_allowed_total counter");
  lines.push(`fortexa_decisions_allowed_total ${snapshot.counters.allow}`);

  lines.push("# HELP fortexa_decisions_denied_total Total decisions that stopped the action");
  lines.push("# TYPE fortexa_decisions_denied_total counter");
  lines.push(`fortexa_decisions_denied_total ${snapshot.counters.deny}`);

  lines.push(
    "# HELP fortexa_rate_limit_rejections_total Total requests rejected by the rate limiter"
  );
  lines.push("# TYPE fortexa_rate_limit_rejections_total counter");
  lines.push(`fortexa_rate_limit_rejections_total ${snapshot.counters.rateLimit}`);

  push(
    renderHelpLine(
      "fortexa_stellar_submit_results_total",
      "Total Stellar submission attempts by result"
    )
  );
  push(renderTypeLine("fortexa_stellar_submit_results_total", "counter"));
  for (const [result, count] of stellarSubmitResultCounts) {
    push(renderMetricLine("fortexa_stellar_submit_results_total", { result }, count));
  }

  return `${lines.join("\n")}\n`;
}

export function recordDecisionOutcome(outcome: DecisionOutcome) {
  // Only allow low-cardinality allowlisted outcomes; drop free-text/wallet injection
  const normalized = String(outcome).trim().toUpperCase();
  if (!ALLOWED_OUTCOMES.has(normalized as DecisionOutcome)) {
    return;
  }
  const safeOutcome = normalized as DecisionOutcome;
  decisionOutcomeCounts.set(safeOutcome, (decisionOutcomeCounts.get(safeOutcome) ?? 0) + 1);
}

export function recordStellarSubmitResult(result: StellarSubmitResult) {
  if (!ALLOWED_RESULTS.has(result as StellarSubmitResult)) {
    return;
  }
  stellarSubmitResultCounts.set(
    result as StellarSubmitResult,
    (stellarSubmitResultCounts.get(result as StellarSubmitResult) ?? 0) + 1
  );
}

export function resetMetrics() {
  buckets.clear();
  decisionOutcomeCounts.clear();
  stellarSubmitResultCounts.clear();
  rateLimitRejections = 0;
}

export function recordRateLimitRejection() {
  rateLimitRejections += 1;
}

export function getRateLimitRejectionCount(): number {
  return rateLimitRejections;
}

export function getDecisionOutcomeCounts(): ReadonlyMap<DecisionOutcome, number> {
  return decisionOutcomeCounts;
}

export function getStellarSubmitResultCounts(): ReadonlyMap<StellarSubmitResult, number> {
  return stellarSubmitResultCounts;
}
