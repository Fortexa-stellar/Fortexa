# Fortexa Observability Guide

Fortexa exposes lightweight, Prometheus-compatible metrics for every API route. This guide covers how to scrape them, sample PromQL for common dashboards/alerts, and where to look inside the app.

> Metrics implementation: [`src/lib/observability/metrics.ts`](../src/lib/observability/metrics.ts)

---

## Endpoints

| Endpoint                             | Purpose                                                      | Auth                    |
| ------------------------------------ | ------------------------------------------------------------ | ----------------------- |
| `GET /api/health`                    | Liveness check                                               | None                    |
| `GET /api/metrics`                   | JSON snapshot of all route buckets plus the `counters` block | Operator session cookie |
| `GET /api/metrics?format=prometheus` | Prometheus text exposition (v0.0.4)                          | Operator session cookie |

The `/ops` page in the app renders the same snapshot for human operators.

### Auth

Both `/api/metrics` variants require an **operator** session. Fortexa uses an HMAC-signed cookie named `fortexa_session`, set when a wallet signs in via `POST /api/auth/login`.

For local development (when `FORTEXA_OPERATOR_WALLETS` is unset), any valid-format Stellar public key resolves to the operator role. In production, set `FORTEXA_OPERATOR_WALLETS` to the comma-separated list of operator wallet keys.

---

## Exported metrics

All series are labeled by `route` (Next.js route path, e.g. `/api/decision`) and `method` (uppercase HTTP verb).

Metric names and label keys are enforced by an allowlist at export time (`ALLOWED_METRIC_NAMES` / `ALLOWED_LABEL_KEYS` in [`src/lib/observability/metrics.ts`](../src/lib/observability/metrics.ts)): series carrying any other label (e.g. `destination`, `memo`) or an undocumented name are dropped, and help text is passed through `redactMetricText` before rendering.

| Metric                                  | Type    | Description                                                                                                                                       |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fortexa_requests_total`                | counter | Total API requests by route/method                                                                                                                |
| `fortexa_request_errors_total`          | counter | Requests that returned HTTP >= 400                                                                                                                |
| `fortexa_request_duration_ms_p95`       | gauge   | Rolling p95 latency in milliseconds (last 500 samples per bucket)                                                                                 |
| `fortexa_decision_outcomes_total`       | counter | Decision evaluations labelled by `outcome` (APPROVE \| WARN \| REQUIRE_APPROVAL \| BLOCK)                                                         |
| `fortexa_stellar_submit_results_total`  | counter | Stellar submission attempts labelled by `result` (success \| horizon_failure \| validation_failure \| idempotency_replay \| idempotency_conflict) |
| `fortexa_decisions_allowed_total`       | counter | Rolled up: decisions that let the action proceed (`APPROVE` + `WARN`)                                                                             |
| `fortexa_decisions_denied_total`        | counter | Rolled up: decisions that stopped the action (`REQUIRE_APPROVAL` + `BLOCK`)                                                                       |
| `fortexa_rate_limit_rejections_total`   | counter | Requests the rate limiter rejected with HTTP 429                                                                                                  |
| `fortexa_stellar_submit_failures_total` | counter | Rolled up: submissions that did not settle on-chain (everything except `success` and `idempotency_replay`)                                        |

The four rolled-up counters are the same numbers the ops dashboard renders. They are
derived from in-process counters only (never from a scan of the audit table) and are
always emitted, zero-initialised, so alert rules never break on a freshly restarted
process.

Sample output:

```
# HELP fortexa_requests_total Total API requests by route/method
# TYPE fortexa_requests_total counter
fortexa_requests_total{route="/api/health",method="GET"} 5
fortexa_requests_total{route="/api/decision",method="POST"} 2
# HELP fortexa_request_errors_total Total API errors by route/method
# TYPE fortexa_request_errors_total counter
fortexa_request_errors_total{route="/api/health",method="GET"} 0
# HELP fortexa_request_duration_ms_p95 P95 request duration in milliseconds
# TYPE fortexa_request_duration_ms_p95 gauge
fortexa_request_duration_ms_p95{route="/api/health",method="GET"} 1.00
# HELP fortexa_decisions_allowed_total Total decisions that were allowed to proceed
# TYPE fortexa_decisions_allowed_total counter
fortexa_decisions_allowed_total 2
# HELP fortexa_decisions_denied_total Total decisions that stopped the action
# TYPE fortexa_decisions_denied_total counter
fortexa_decisions_denied_total 1
# HELP fortexa_rate_limit_rejections_total Total requests rejected by the rate limiter
# TYPE fortexa_rate_limit_rejections_total counter
fortexa_rate_limit_rejections_total 0
# HELP fortexa_stellar_submit_failures_total Total Stellar submissions that did not settle on-chain
# TYPE fortexa_stellar_submit_failures_total counter
fortexa_stellar_submit_failures_total 0
```

> Note: `p95` is exported as a gauge computed from an in-memory ring buffer (last 500 observations per route), not as a Prometheus histogram. It is intended for at-a-glance dashboards, not high-fidelity SLO math.

### JSON snapshot shape

```jsonc
{
  "service": "fortexa",
  "timestamp": "2026-09-30T08:00:00.000Z",
  "totals": { "totalCount": 12, "errorCount": 1, "errorRate": 0.083 },
  "counters": { "allow": 2, "deny": 1, "rateLimit": 0, "submitFailures": 0 },
  "routes": [/* route/method buckets */],
}
```

`counters` is what the in-app dashboard renders, byte for byte: the server component
that loads the Ops tab calls `getMetricsSnapshot()` and passes the result to
`src/components/ops-dashboard.tsx`, so the screen and this body cannot drift.

---

## Prometheus scrape config

Fortexa's metrics endpoint is cookie-protected. Use Prometheus' `authorization` or `cookies` support via the `Cookie` header to authenticate.

```yaml
scrape_configs:
  - job_name: fortexa
    metrics_path: /api/metrics
    params:
      format: [prometheus]
    scheme: https
    scrape_interval: 30s
    scrape_timeout: 10s
    static_configs:
      - targets:
          - fortexa.your-domain.example
    # Operator session cookie minted from POST /api/auth/login
    # Store the cookie value in a file and reference it here.
    authorization:
      type: ""
    # Prometheus does not natively support cookie auth headers; use a
    # request header instead:
    # (Prometheus 2.26+ supports `http_headers`)
    http_headers:
      Cookie:
        values:
          - "fortexa_session=<paste-signed-token-here>"
```

If your environment does not allow long-lived cookies, an alternative is to put a small auth-injecting proxy (e.g. nginx, Envoy, or a sidecar) in front of Fortexa that adds the `Cookie` header on each request.

### Local verification

```bash
# 1. Log in (any valid-format Stellar pubkey works when no operator allowlist is set)
curl -s -c /tmp/fortexa-cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"publicKey":"GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR"}' \
  http://localhost:3001/api/auth/login

# 2. Scrape
curl -b /tmp/fortexa-cookies.txt \
  "http://localhost:3001/api/metrics?format=prometheus"
```

---

## Sample PromQL

### Request rate per route (requests/sec, 5-minute window)

```promql
sum by (route) (rate(fortexa_requests_total[5m]))
```

### Error rate per route (fraction, 5-minute window)

```promql
sum by (route) (rate(fortexa_request_errors_total[5m]))
  /
sum by (route) (rate(fortexa_requests_total[5m]))
```

### Overall error rate

```promql
sum(rate(fortexa_request_errors_total[5m]))
  /
sum(rate(fortexa_requests_total[5m]))
```

### p95 latency per route (ms)

```promql
max by (route) (fortexa_request_duration_ms_p95)
```

### Top 5 noisiest routes by request count (last 1h)

```promql
topk(5, sum by (route) (increase(fortexa_requests_total[1h])))
```

### Decision outcome breakdown (rate over 5 minutes)

```promql
sum by (outcome) (rate(fortexa_decision_outcomes_total[5m]))
```

### Fraction of decisions that resulted in BLOCK

```promql
rate(fortexa_decision_outcomes_total{outcome="BLOCK"}[5m])
  /
sum(rate(fortexa_decision_outcomes_total[5m]))
```

### Stellar submission success rate (5-minute window)

```promql
rate(fortexa_stellar_submit_results_total{result="success"}[5m])
  /
sum(rate(fortexa_stellar_submit_results_total[5m]))
```

### Stellar submission results breakdown

```promql
sum by (result) (rate(fortexa_stellar_submit_results_total[5m]))
```

### Decision throughput: allowed vs denied (5-minute window)

```promql
rate(fortexa_decisions_allowed_total[5m])
  +
rate(fortexa_decisions_denied_total[5m])
```

### Share of decisions that were denied

```promql
rate(fortexa_decisions_denied_total[5m])
  /
clamp_min(
  rate(fortexa_decisions_allowed_total[5m]) + rate(fortexa_decisions_denied_total[5m]),
  1e-9
)
```

### Rate-limit rejections per second

```promql
rate(fortexa_rate_limit_rejections_total[5m])
```

### Signed submission failures per second

```promql
rate(fortexa_stellar_submit_failures_total[5m])
```

### Example alert — sustained elevated error rate

```yaml
groups:
  - name: fortexa
    rules:
      - alert: FortexaHighErrorRate
        expr: |
          (
            sum by (route) (rate(fortexa_request_errors_total[5m]))
            /
            sum by (route) (rate(fortexa_requests_total[5m]))
          ) > 0.05
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Fortexa error rate >5% on {{ $labels.route }}"
```

---

## Grafana

A minimal importable dashboard with the three panels above lives at
[`docs/grafana/fortexa-minimal.json`](grafana/fortexa-minimal.json).

To import:

1. In Grafana, go to **Dashboards → New → Import**.
2. Upload `fortexa-minimal.json` (or paste its contents).
3. When prompted, select your Fortexa Prometheus datasource for the `DS_PROMETHEUS` variable.

Panels:

- **Request rate by route** — `sum by (route) (rate(fortexa_requests_total[5m]))`
- **Error rate by route** — error counter / request counter, with 5% / 10% threshold lines
- **p95 latency by route** — `max by (route) (fortexa_request_duration_ms_p95)`

---

## In-app dashboard

For operators who don't want to wire up Prometheus, the `/ops` page renders the same snapshot:

- Allowed / denied / rate-limited / submit-failure counters, read straight off the metrics snapshot
- Service health (from `/api/health`)
- Total requests / error rate / signed tx count
- Top routes and rolling trend

`/ops` is gated by operator session, same as `/api/metrics`.

### One snapshot, two views

The Ops tab is loaded by a server component
([`src/app/settings/page.tsx`](../src/app/settings/page.tsx)), which calls
`getMetricsSnapshot()` in-process and hands the snapshot to
[`src/components/ops-dashboard.tsx`](../src/components/ops-dashboard.tsx). Consequences worth
knowing when reading the screen:

- The four counters are **never** recomputed by scanning the audit table. They are the same
  values the `/api/metrics` body and the Prometheus text export.
- An empty snapshot renders `0` in each tile instead of an endless spinner.
- The dashboard still polls `/api/metrics` every 8s for route/traffic refresh, so the numbers
  keep moving without a reload; each poll returns the same snapshot shape, so both views stay
  consistent.

Tests: [`src/components/ops-dashboard.snapshot.test.tsx`](../src/components/ops-dashboard.snapshot.test.tsx)
(renders from a snapshot, never fetches over HTTP) and
[`src/app/api/metrics/route.test.ts`](../src/app/api/metrics/route.test.ts) (route body
parity).

---

## Notes & caveats

- **In-memory only.** All buckets live in the Node process. Restarting the server resets counters. For long-term retention, scrape into Prometheus.
- **Per-instance.** If Fortexa is horizontally scaled, each replica exposes its own counters. Aggregate with `sum by (route)` in PromQL.
- **No histogram.** p95 is a gauge derived from a 500-sample ring buffer, not a true Prometheus histogram. Don't use it for cross-instance percentile aggregation.
- **Local vs deployed auth.** Locally, no allowlist means any pubkey works. In production, set `FORTEXA_OPERATOR_WALLETS` to restrict.
- **Ops UI is single-instance.** The dashboard reads the snapshot of the instance that served the page, so a load-balanced setup shows the replica the operator happened to hit. Prometheus is the source of truth for fleet-wide numbers.

---

## Audit Export Verifier

Fortexa stores a tamper-evident hash chain in every audit entry (`entryHash` / `previousHash`).
The verifier CLI lets you confirm integrity of an exported audit file **without** a database,
wallet session, or running Next.js server.

### Usage

    npx tsx scripts/verify-audit-export.ts <path-to-export.json>

Or via the package script:

    npm run verify:audit -- <path-to-export.json>

### Export formats supported

| Format      | Example shape                                        |
| ----------- | ---------------------------------------------------- |
| Plain array | [{"id": "...", "entryHash": "...", ...}]             |
| scope=mine  | {"scope": "mine", "entries": [...]}                  |
| scope=all   | {"scope": "all", "entriesByUser": {"userId": [...]}} |

### Exit codes

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| 0    | Chain valid                                             |
| 1    | Chain invalid (tampered, deleted, or reordered entries) |
| 2    | File not found, unreadable, or unrecognized format      |

### Test fixtures

Reference fixtures live in scripts/fixtures/:

| File                   | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| valid-chain.json       | 3-entry valid chain (plain array)                  |
| valid-mine-export.json | 2-entry valid chain (scope=mine)                   |
| valid-all-export.json  | Valid multi-user export (scope=all)                |
| tampered-field.json    | Entry with modified explanation (tamper detection) |
| deleted-entry.json     | Middle entry removed (gap detection)               |
| reordered-entries.json | Timestamps swapped to disguise reordering          |
