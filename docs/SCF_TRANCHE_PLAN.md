# Stellar Community Fund (SCF) Tranche Plan

This document outlines the funding tranches and key deliverables for Fortexa, structured around the Stellar Community Fund (SCF) Build-style framework. The deliverables are derived directly from the existing code structure, tests, database migrations, and observability tools implemented in this repository.

---

## Tranche 1: Policy Firewall Hardening and Reviewer Evidence

This tranche focuses on core policy validation engine rules, simulation checks, and cryptographic evidence mechanisms that verify the integrity of firewall decisions before transactions are signed.

### Deliverable 1.1: Deterministic Policy Rules Validation Engine

- **Scope**: Core deterministic policy checking rules governing spending caps, permitted hours, and allowed domain/tool scopes.
- **Repository Artifact**: [src/lib/policy/engine.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/policy/engine.ts)
- **Acceptance Criteria**: The file [engine.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/policy/engine.ts) exists, and all unit tests in [src/lib/policy/engine.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/policy/engine.test.ts) pass successfully.
- **Why it matters for Stellar agent payments**: Prevents autonomous agents from executing unapproved payment intents, exceeding daily spending budgets, or triggering payouts outside authorized business hours.
- **Risk Level**: Low

### Deliverable 1.2: Pre-Save Policy Simulation Engine

- **Scope**: Running read-only dry-runs/simulations of policy draft modifications against historical audit entries and scenario matrices before committing them to the store.
- **Repository Artifact**: [src/lib/decision/simulate.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/decision/simulate.ts) & [src/app/api/policy/simulate/route.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/policy/simulate/route.ts)
- **Acceptance Criteria**: The simulation API endpoint returns a 200 comparison payload indicating `current → proposed` outcomes, and simulation tests in [src/lib/decision/simulate.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/decision/simulate.test.ts) pass.
- **Why it matters for Stellar agent payments**: Enables operators to safely tweak firewall policy parameters without introducing unintended blockages to agent payment pipelines or accidentally relaxing safety guardrails.
- **Risk Level**: Medium

### Deliverable 1.3: Evidence Hash Chain Integrity Verification

- **Scope**: Cryptographically chaining consecutive audit entries via SHA-256 hashes to detect tampering, deletion, or reordering of decisions.
- **Repository Artifact**: [src/lib/audit/hash-chain.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/audit/hash-chain.ts)
- **Acceptance Criteria**: `verifyHashChain` utility correctly detects log mutations and returns detailed structural failure reasons; tests in [src/lib/audit/hash-chain.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/audit/hash-chain.test.ts) pass.
- **Why it matters for Stellar agent payments**: Guarantees an immutable, verifiable proof-of-decision history matching transaction submissions, making it impossible to hide unauthorized payment overrides.
- **Risk Level**: Medium

### Deliverable 1.4: Heuristic Risk Analyzer

- **Scope**: Computing dynamic risk scores and surfacing findings (such as high transaction speed or domain pattern anomalies) to trigger human reviews.
- **Repository Artifact**: [src/lib/security/analyzer.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/security/analyzer.ts)
- **Acceptance Criteria**: The risk analysis function computes score thresholds correctly, and unit tests in [src/lib/security/analyzer.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/security/analyzer.test.ts) pass.
- **Why it matters for Stellar agent payments**: Acts as a defensive layer catching suspicious payment parameters that standard deterministic rules might miss, blocking suspicious transactions until manually authorized.
- **Risk Level**: Medium

### Deliverable 1.5: Wallet Authentication and Challenge-Response Flow

- **Scope**: Session-issuance and wallet challenge login verification based on Freighter SEP-53 client signatures.
- **Repository Artifact**: [src/lib/auth/wallet-challenge.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/auth/wallet-challenge.ts)
- **Acceptance Criteria**: Challenge generation, signing verification, and authentication state resolve successfully; tests in [src/lib/auth/wallet-challenge.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/auth/wallet-challenge.test.ts) pass.
- **Why it matters for Stellar agent payments**: Limits administrator and operator action capabilities strictly to users holding valid private keys, locking access control to Stellar credentials.
- **Risk Level**: Medium

### Deliverable 1.6: Local Storage File Fallback Handler

- **Scope**: Relational database persistence with clean file-based fallback storage to ensure offline database resilience.
- **Repository Artifact**: [src/lib/storage/db.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/storage/db.ts)
- **Acceptance Criteria**: Persistent operations fail-over gracefully to local store JSON files on database timeout or connection error; tests in [src/lib/storage/db.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/storage/db.test.ts) pass.
- **Why it matters for Stellar agent payments**: Prevents payments from failing or stalling when the relational database database connection is lost or experiencing downtime.
- **Risk Level**: Low

---

## Tranche 2: Operator Pilot Readiness, Observability, and Audit Exports

This tranche focuses on system telemetry, audit visibility, idempotent transaction submission, and blocklist integrations required for deploying pilots in staging or early environments.

### Deliverable 2.1: Prometheus-Compatible Telemetry Scraper

- **Scope**: Exposing system metrics and API transaction performance benchmarks to Prometheus scraping configurations.
- **Repository Artifact**: [src/app/api/metrics/route.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/metrics/route.ts) & [src/lib/observability/metrics.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/observability/metrics.ts)
- **Acceptance Criteria**: Querying `/api/metrics?format=prometheus` returns metrics in scrape-compatible format, and unit tests in [src/lib/observability/metrics.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/observability/metrics.test.ts) pass.
- **Why it matters for Stellar agent payments**: Allows monitoring services to alert operators immediately when the firewall is overloaded, latency increases, or transaction failures spike.
- **Risk Level**: Low

### Deliverable 2.2: Audit Trails Export Route

- **Scope**: Exporting complete decision histories and cryptographic hashes in CSV or JSON format for external review.
- **Repository Artifact**: [src/app/api/audit/export/route.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/audit/export/route.ts)
- **Acceptance Criteria**: Export route returns correctly filtered records based on scopes, and tests in [src/app/api/audit/export/route.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/audit/export/route.test.ts) pass.
- **Why it matters for Stellar agent payments**: Provides financial regulators or internal reviewers with an exportable ledger to reconcile firewall approvals with actual Stellar account balances.
- **Risk Level**: Low

### Deliverable 2.3: Wallet-Bound Session and Gated Routes Auth Guard

- **Scope**: Securing application endpoints and role validation based on HMAC cookie authentication and operator/viewer permission boundaries.
- **Repository Artifact**: [src/lib/auth/require-auth.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/auth/require-auth.ts) & [src/lib/auth/session.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/auth/session.ts)
- **Acceptance Criteria**: Access control blocks unauthorized actions and enforces role scopes; tests in [src/lib/auth/session.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/auth/session.test.ts) pass.
- **Why it matters for Stellar agent payments**: Ensures that only authenticated operators can build transactions, approve plans, or alter the firewall security state.
- **Risk Level**: Medium

### Deliverable 2.4: Idempotency Submission Key Protection

- **Scope**: Preventing double-submission errors in payment transactions via user-key mapping and cached transaction hash checks.
- **Repository Artifact**: [src/app/api/stellar/submit-signed/route.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/stellar/submit-signed/route.ts)
- **Acceptance Criteria**: The endpoint claims the idempotency key before submitting, returns the stored status and transaction id on replay, and returns 409 on a mismatched body without building a second payment; tests in [src/app/api/stellar/submit-signed-idempotency.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/stellar/submit-signed-idempotency.test.ts) and [src/lib/storage/submit-idempotency-store.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/storage/submit-idempotency-store.test.ts) pass.
- **Why it matters for Stellar agent payments**: Protects automated agents from executing duplicate payments if client apps or API gateways trigger redundant retries under flaky network conditions.
- **Risk Level**: Medium

### Deliverable 2.5: Dynamic Threat-Intel Blocklist Cache

- **Scope**: In-memory domain caching and lookup against a configured external threat-intelligence domain feed.
- **Repository Artifact**: [src/lib/security/blocklist.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/security/blocklist.ts)
- **Acceptance Criteria**: The blocklist checker correctly caches URLs for 5 minutes and flags blocked domains; tests in [src/lib/security/blocklist.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/security/blocklist.test.ts) pass.
- **Why it matters for Stellar agent payments**: Stops agents from sending transaction funds to recently identified malicious domains or fraudulent Stellar gateway interfaces.
- **Risk Level**: Low

### Deliverable 2.6: Payment Quote Verification Boundary

- **Scope**: Hard-checking built transactions to ensure they match approved policy quotes without modifications.
- **Repository Artifact**: [src/lib/stellar/verify-payment-quote.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/stellar/verify-payment-quote.ts)
- **Acceptance Criteria**: Transaction destination, amount, memo, and network are verified, rejecting any parameter shifts; tests in [src/lib/stellar/verify-payment-quote.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/stellar/verify-payment-quote.test.ts) pass.
- **Why it matters for Stellar agent payments**: Guarantees that the payload the agent signs matches the transaction parameter set authorized by the firewall engine.
- **Risk Level**: Medium

---

## Tranche 3: Production Deployment Readiness and Ecosystem Integrations

This tranche targets cluster-wide security state persistence, integration with LLM agent planning components, setup scripts, and operational runbooks for production deployments.

### Deliverable 3.1: Shared State Lockout and Rate Limiter

- **Scope**: Distributed session lockouts and login attempts rate-limiting supported by local file storage or Redis instances.
- **Repository Artifact**: [src/lib/security/shared-security-state.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/security/shared-security-state.ts)
- **Acceptance Criteria**: Rate limit locks are updated in shared state, and tests in [src/lib/security/rate-limit.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/security/rate-limit.test.ts) and [src/lib/security/shared-security-state.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/security/shared-security-state.test.ts) pass.
- **Why it matters for Stellar agent payments**: Protects distributed firewall setups (e.g. Vercel or Kubernetes pods) from brute-force authentication attacks on operator keys.
- **Risk Level**: Medium

### Deliverable 3.2: Horizon Testnet Client Submission Integration

- **Scope**: Connecting transaction construction, validation, and network submission to Stellar Horizon Testnet endpoints.
- **Repository Artifact**: [src/lib/stellar/client.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/stellar/client.ts) & [src/app/api/stellar/build-payment/route.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/stellar/build-payment/route.ts)
- **Acceptance Criteria**: Built XDR is compiled and submitted successfully using the Stellar SDK library; tests in [src/app/api/stellar/build-payment/route.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/stellar/build-payment/route.test.ts) pass.
- **Why it matters for Stellar agent payments**: Provides the actual on-chain transaction bridge converting firewall decisions into settled Stellar ledger entries.
- **Risk Level**: Medium

### Deliverable 3.3: LLM Agent Planning Console Route

- **Scope**: Evaluating agent action plans and intents submitted through natural language API routes backed by Groq LLM configurations.
- **Repository Artifact**: [src/app/api/agent/plan/route.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/app/api/agent/plan/route.ts)
- **Acceptance Criteria**: Endpoint handles prompts and evaluates actions, and scenario tests in [src/lib/decision/engine.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/decision/engine.test.ts) pass successfully.
- **Why it matters for Stellar agent payments**: Integrates unstructured agent planning inputs directly into structured policy checks before triggering financial actions.
- **Risk Level**: High

### Deliverable 3.4: Database Migrations and Tracking Schema

- **Scope**: Orchestrating SQL tables, indexes, and schema migration checkpoints for persistent stores.
- **Repository Artifact**: [src/lib/storage/migrations.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/storage/migrations.ts) & [scripts/run-db-migrations.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/scripts/run-db-migrations.ts)
- **Acceptance Criteria**: Migration definitions exist, and `npm run db:migrate` successfully applies migrations to the active database.
- **Why it matters for Stellar agent payments**: Guarantees that the relational schema (wallets, history, audit, and idempotency states) is safely initialized on clean database instances.
- **Risk Level**: Low

### Deliverable 3.5: Local Developer Safe Reset Handler

- **Scope**: Local-only developer helper for state cleanup with hostname safety check.
- **Repository Artifact**: [scripts/reset-local-demo-state.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/scripts/reset-local-demo-state.ts)
- **Acceptance Criteria**: The script safely resets local files/tables when all guardrails are met, and unit tests in [src/lib/storage/reset-local-demo-state.test.ts](file:///c:/Users/ICT%20LASIEC/Fortexa/src/lib/storage/reset-local-demo-state.test.ts) pass.
- **Why it matters for Stellar agent payments**: Enables developers and reviewers to quickly restore clean demo scenarios and verify firewall behavior without risking production data loss.
- **Risk Level**: Low

### Deliverable 3.6: Prometheus Monitoring Infrastructure Alert Configurations

- **Scope**: Documentation and template files for setting up Prometheus scrape jobs, Alertmanager alerting rules, and Grafana dashboard assets.
- **Repository Artifact**: [docs/observability.md](file:///c:/Users/ICT%20LASIEC/Fortexa/docs/observability.md) & [docs/grafana](file:///c:/Users/ICT%20LASIEC/Fortexa/docs/grafana)
- **Acceptance Criteria**: Complete Prometheus rules and Grafana configuration specs exist in the repository, and the walkthrough documentation is complete.
- **Why it matters for Stellar agent payments**: Provides production operators with out-of-the-box infrastructure visibility and immediate alerts for critical firewall errors or transaction submission failures.
- **Risk Level**: Low
