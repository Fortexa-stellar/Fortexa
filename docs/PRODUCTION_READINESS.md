# 🚀 Fortexa Production Readiness Checklist

This document details the operational baseline, hardening criteria, and verification workflows required to promote a Fortexa deployment safely into a high-availability production environment.

---

## 1. Required Environment Variables Matrix

| Variable Name      | Local/Dev Default  | Production Expectation                  | Security & Validation Requirements                                          |
| :----------------- | :----------------- | :-------------------------------------- | :-------------------------------------------------------------------------- |
| `NODE_ENV`         | `development`      | `production`                            | Enables performance optimizations and disables verbose stack traces.        |
| `PORT`             | `3000`             | `8080` (or dynamic)                     | Non-root system application port.                                           |
| `DATABASE_URL`     | `postgresql://...` | `postgresql://user:secure@host:5432/db` | Enforce SSL connections (`sslmode=require`).                                |
| `JWT_SECRET`       | `dev-secret-key`   | _Cryptographic String_                  | Min 32-character random string stored in a secure Secrets Manager.          |
| `WALLET_ALLOWLIST` | `*`                | `G...,D...`                             | Explicit comma-separated Stellar addresses authorized to sign transactions. |
| `METRICS_ENABLED`  | `true`             | `true`                                  | Exposes standard monitoring endpoints.                                      |
| `STORAGE_FALLBACK` | `file`             | `database`                              | Production must rely entirely on transactional databases, not local disks.  |

---

## 2. Infrastructure & Access Management Configurations

### Wallet Allowlisting

- **Operator Wallet Configuration:** Explicitly restrict administrative and operational transaction capabilities using a static allowlist environment string.
- **Zero Wildcards:** Set the `WALLET_ALLOWLIST` value to exact Stellar public keys. Never leave this parameter blank or wildcarded (`*`) in production.

### Authentication Hardening

- All deployment authentication tokens must rely on a cryptographically secure `JWT_SECRET`.
- Rotate keys periodically via an automated pipeline without bringing down execution engines.

### Storage Configurations

- **Database Target:** Set `STORAGE_FALLBACK=database` to prevent transaction payloads or internal structural files from being written to volatile, ephemeral containers or local nodes.

---

## 3. Observability, Metrics & Dashboard Setup

Fortexa includes a Prometheus-compatible data metrics output interface for fast integration into centralized alerting grids.

- **Metrics Endpoint:** Exposes live runtime status information metrics on `/metrics`.
- **Grafana Dashboard Configuration:** * Import our standard production monitoring dashboard via the configuration code template located at `docs/observability/grafana-template.json`.
  - Track active KPIs including: HTTP Request Latency, Active DB Connection Pool Depth, Stellar Transaction Submission Success Rates, and 5xx Error Spike Thresholds.

---

## 4. Backups, Audit Logs & Disaster Recovery

- **Database Backups:** Automated daily incremental snapshots with point-in-time recovery (PITR) up to 30 days minimum.
- **Audit Trail Preservation:** Audit logs must be continuously offloaded directly from the application layer into non-volatile, append-only cold storage buckets (e.g., AWS S3 with Object Lock or secure cloud logging architectures) to comply with external financial transparency metrics.
- **Recovery Drill Validation:** Restore dry-runs must be performed quarterly to verify system decryption handshakes function cleanly without data corruption.

---

## 5. Deployment Verification & Health Checks

Execute these verification checks immediately following an active rolling container update to confirm system stability before routing traffic live:

1. **Ping Diagnostic Endpoint:** Run `GET /healthz` (code referenced in `src/routes/healthz.ts`).
   - _Expected Response:_ `200 OK`
   - _Validation Criteria:_ Ensure no internal downstream infrastructure segments (e.g., Postgres pool, caching layers) are returning fallback or initialization failures.
2. **Ping Metrics Pipeline:** Run `GET /metrics`.
   - _Expected Response:_ `200 OK` with valid open-metrics formatted context strings.
3. **Verify Auth Barrier Protection:** Attempt an unauthenticated request to an internal route.
   - _Expected Response:_ `401 Unauthorized`.

---

## 6. Known Non-Goals (Pre-Mainnet Scope)

The following capabilities are explicitly omitted from the current system architecture phase and should not delay pilot validation tracks:

- Automated multi-region database master clusters replication failover.
- Dynamic programmatic on-chain wallet balance automatic replenishment routines.
- End-user self-service key rotation interfaces.

---

## 7. 🚦 Final Go / No-Go Operational Sign-Off Matrix

Before routing active customer workloads or mainnet payment traffic through this cluster deployment instance, the operator must verify every gate condition below passes perfectly:

- [ ] **Secrets Isolated:** No production tokens, API keys, or private seed arrays exist within any commit history files or active configuration repos.
- [ ] **Database Bound:** System is explicitly verified to be writing historical data records onto the persistent DB cluster rather than local disk buffers (`STORAGE_FALLBACK=database`).
- [ ] **Health Route Clear:** `/healthz` successfully resolves to status code `200 OK` across all running cluster service containers.
- [ ] **Metrics Alive:** Live runtime statistics are being actively scraped from `/metrics` by the centralized monitoring infrastructure.
- [ ] **Allowlist Enforced:** The wallet verification array contains explicitly designated public keys and rejects unauthorized connection variants.

**Result Definition:** If any item listed above is left unchecked, the deployment status remains **NO-GO**. Fix omissions before launching live traffic streams.
