# Security Changelog

All security-relevant behavior changes to **Fortexa** across authentication, policy evaluation, audit evidence, and Stellar payment execution are documented in this file.

## Format

When a pull request changes security-sensitive behavior (any item marked **changed** under *Security-sensitive behavior* in [`.github/pull_request_template.md`](.github/pull_request_template.md)), add a concise bullet under `## [Unreleased]` in the matching section:

- Sections: `### Auth`, `### Policy`, `### Audit`, `### Payment`
- Entry format: `- **[Added | Changed | Fixed | Removed]** Concise description of the behavior change and affected route or module.`
- Keep entries factual, reviewer-verifiable, and linked to repository paths where applicable.

---

## [Unreleased]

### Auth
- None yet.

### Policy
- None yet.

### Audit
- None yet.

### Payment
- None yet.

---

## [1.0.0] - 2026-06-29 — Security Baseline

### Auth
- **[Added]** Wallet challenge-signature login flow ([`POST /api/auth/challenge`](src/app/api/auth/challenge/route.ts), [`POST /api/auth/login`](src/app/api/auth/login/route.ts), [`src/lib/auth/wallet-challenge.ts`](src/lib/auth/wallet-challenge.ts)) using SEP-53 Ed25519 message signing, one-time challenge consumption, and configurable TTL (`FORTEXA_AUTH_CHALLENGE_TTL_SECONDS`).
- **[Added]** HMAC-signed session cookies (`fortexa_session` in [`src/lib/auth/session.ts`](src/lib/auth/session.ts)), 24-hour wallet mapping expiry ([`src/lib/storage/user-wallet-store.ts`](src/lib/storage/user-wallet-store.ts)), and explicit operator session-wallet revocation ([`DELETE /api/auth/wallet/revoke`](src/app/api/auth/wallet/revoke/route.ts)).
- **[Added]** Role-based access control (`operator` and `viewer` allowlists via [`src/lib/auth/wallet-role.ts`](src/lib/auth/wallet-role.ts) and [`src/lib/auth/require-auth.ts`](src/lib/auth/require-auth.ts)) and brute-force login lockout with per-route rate limiting ([`src/lib/auth/login-lockout.ts`](src/lib/auth/login-lockout.ts)).

### Policy
- **[Added]** Deterministic policy and risk decisioning ([`src/lib/policy/engine.ts`](src/lib/policy/engine.ts), [`src/lib/security/analyzer.ts`](src/lib/security/analyzer.ts), [`src/lib/decision/engine.ts`](src/lib/decision/engine.ts)) enforcing per-transaction and daily XLM caps, domain/tool allowlists and blocklists, allowed hours, and human-approval gates (`BLOCK`, `REQUIRE_APPROVAL`, `WARN`, `APPROVE`).
- **[Added]** Read-only pre-save policy simulation ([`POST /api/policy/simulate`](src/app/api/policy/simulate/route.ts), [`src/lib/decision/simulate.ts`](src/lib/decision/simulate.ts)), versioned policy history with candidate decision-impact diffing ([`GET /api/policy/history`](src/app/api/policy/history/route.ts), [`src/lib/validation/diff.ts`](src/lib/validation/diff.ts)), and operator-gated rollback ([`POST /api/policy/rollback`](src/app/api/policy/rollback/route.ts)).
- **[Added]** Fail-closed stored policy validation and optional-field migration ([`src/lib/policy/migrations.ts`](src/lib/policy/migrations.ts)).

### Audit
- **[Added]** Append-only per-user decision and execution audit log linked by a tamper-evident SHA-256 hash chain (`previousHash`, `entryHash`) verified via [`src/lib/audit/hash-chain.ts`](src/lib/audit/hash-chain.ts) and [`scripts/verify-audit-export.ts`](scripts/verify-audit-export.ts).
- **[Added]** Recursive secret, session, token, and signed-XDR redaction ([`src/lib/audit/redact.ts`](src/lib/audit/redact.ts)) and header-safe filename sanitization on JSON and CSV audit exports ([`GET /api/audit/export`](src/app/api/audit/export/route.ts)).
- **[Added]** Contained file-store path resolution ([`src/lib/storage/paths.ts`](src/lib/storage/paths.ts)) rejecting directory traversal and symlinks outside `FORTEXA_STORE_DIR`.

### Payment
- **[Added]** Non-custodial, wallet-bound signed-XDR payment architecture ([`src/lib/stellar/client.ts`](src/lib/stellar/client.ts)) with no server-side private-key storage or signing.
- **[Added]** Quote-to-XDR authorization binding across [`POST /api/decision`](src/app/api/decision/route.ts), [`POST /api/stellar/build-payment`](src/app/api/stellar/build-payment/route.ts), and [`POST /api/stellar/submit-signed`](src/app/api/stellar/submit-signed/route.ts) ([`src/lib/stellar/verify-payment-quote.ts`](src/lib/stellar/verify-payment-quote.ts)), enforcing single-operation payment envelopes, exact integer-stroop amounts, destination/asset/memo parity, and quote TTL freshness.
- **[Added]** Shared pre-execution enforcement gate ([`src/lib/security/enforcement-gate.ts`](src/lib/security/enforcement-gate.ts)) for atomic rate limiting and threat-intel blocklist checks (`FORTEXA_BLOCKLIST_URL`), idempotent submission deduplication ([`src/lib/storage/submit-idempotency-store.ts`](src/lib/storage/submit-idempotency-store.ts)), body size limits ([`src/lib/http/read-json-body.ts`](src/lib/http/read-json-body.ts)), and production readiness checks ([`scripts/check-production-readiness.ts`](scripts/check-production-readiness.ts)).
