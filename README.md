# Fortexa

<p align="center">
  <img src="public/fortexa-logo.jpeg" alt="Fortexa logo" width="200" />
</p>

<p align="center"><strong>Policy-Controlled Payment Firewall for Autonomous Agent Actions on Stellar</strong></p>

Fortexa is a **policy-controlled payment firewall for autonomous agent actions on Stellar**.
It sits between agent intent and economic execution, applies governance/risk checks, and keeps an auditable decision trail.

This document reflects the **current implementation** in this repository.

See [docs/SCF_TRANCHE_PLAN.md](docs/SCF_TRANCHE_PLAN.md) for the Stellar Community Fund (SCF) funding tranches and roadmap alignment.

---

## 1) ⚠️ Why This Matters

Agentic systems can now trigger real payments. That creates a new risk layer: high-speed model decisions can become high-impact economic actions.

Fortexa adds a control plane between intent and money movement:

- Policy checks before execution
- Risk scoring on suspicious behavior
- Human-approval gate for sensitive cases
- Wallet-native signed XDR flow
- Auditable evidence trail for every decision

In short: Fortexa is the safety layer for agentic payments.

---

## 2) 🚀 Jury Demo Flow (Fast Path)

If you only read one section, read this:

1. **Login with wallet** on `/login`.
2. **Evaluate action** in `/console`.
3. Receive decision: **`BLOCK` / `REQUIRE_APPROVAL` / `WARN` / `APPROVE`**.
4. For allowed flows, **build unsigned XDR → sign in wallet → submit signed XDR**.
5. Verify outcome with **Explorer link** and inspect evidence in `/activity` and `/ops`.

### ✅ Reviewer Checklist: Wallet-Bound Payment Flow

The core security premise of Fortexa is that it **does not hold private keys or perform server-side signing.**
This end-to-end flow validates that design:

| Step | UI / Route | Source / Logic | Expected Signal |
|---|---|---|---|
| **1. Login** | `/login` | [`POST /api/auth/login`](src/app/api/auth/login/route.ts) <br> [`src/components/login-form.tsx`](src/components/login-form.tsx) | **Success**: Freighter challenge signed, session issued.<br>**Failure**: Signature mismatch, unauthorized wallet. |
| **2. Decision** | `/console` | [`POST /api/decision`](src/app/api/decision/route.ts) <br> [`src/components/decision-console.tsx`](src/components/decision-console.tsx) | **Success**: Returns `APPROVE` or `WARN` with a fixed payment quote.<br>**Failure**: Returns `BLOCK` (no quote). |
| **3. Quote Lock** | `/console` | [`POST /api/stellar/build-payment`](src/app/api/stellar/build-payment/route.ts) | **Success**: Build request perfectly matches the approved audit entry quote.<br>**Failure**: Server rejects tampered destination, amount, or memo with `403`. |
| **4. Unsigned XDR Build** | `/console` | [`POST /api/stellar/build-payment`](src/app/api/stellar/build-payment/route.ts) | **Success**: Server returns valid unsigned XDR envelope.<br>**Failure**: Network timeout, missing parameters. |
| **5. Wallet Signing** | `/console` | `signTransaction` inside <br> [`src/components/decision-console.tsx`](src/components/decision-console.tsx) | **Success**: Freighter popup appears, user signs, UI holds signed XDR.<br>**Failure**: User rejects in wallet. |
| **6. Signed Submit** | `/console` | [`POST /api/stellar/submit-signed`](src/app/api/stellar/submit-signed/route.ts) | **Success**: Broadcasts successfully to Stellar Testnet (200 OK).<br>**Failure**: Horizon error (`tx_bad_seq`, `op_underfunded`). |
| **7. Explorer Link** | `/console` | [`src/components/decision-console.tsx`](src/components/decision-console.tsx) | **Success**: Clickable link to Stellar Expert confirming hash matches. |
| **8. Audit Evidence** | `/activity`<br>`/ops` | [`GET /api/audit`](src/app/api/audit/route.ts) <br> [`src/app/activity/page.tsx`](src/app/activity/page.tsx) | **Success**: Immutable record of the original decision and execution hash. |

*(Note: Fortexa is currently built for testnet validation. Mainnet readiness requires further risk intel integrations.)*

---

## 3) 🧭 Current Product Model

Fortexa currently runs with a strict wallet-bound model:

1. User logs in with wallet (`/login`).
2. Session is created with role (`operator` / `viewer`).
3. Session wallet is bound as execution source.
4. Actions are evaluated by policy + security engine.
5. Approved/warned decisions can proceed to signed-XDR payment flow.
6. Decision/audit evidence is stored and visible in `/activity` and `/ops`.

---

## 4) 🔐 Auth and Access Control

### 4.1 Wallet-only Login

Fortexa uses a challenge-signature login flow:

1. Client requests a one-time login challenge via `POST /api/auth/challenge` with the wallet public key (`G...`).
2. The server returns a short-lived challenge message bound to that wallet.
3. The wallet signs the challenge message (SEP-53 / Freighter `signMessage`).
4. Client posts `publicKey`, `challengeId`, and `signature` to `POST /api/auth/login`.
5. The server verifies the signature, enforces one-time challenge use + expiry, then issues `fortexa_session`.

Role is still resolved via allowlists:

- `FORTEXA_OPERATOR_WALLETS`
- `FORTEXA_VIEWER_WALLETS`

If both allowlists are empty, current behavior falls back to `operator` role for any valid wallet (recommended only for local/dev).

Session cookie: `fortexa_session` (HMAC-signed).

Challenge TTL: `FORTEXA_AUTH_CHALLENGE_TTL_SECONDS` (default `300`).

### 4.2 Role Permissions

- `operator`: full decision/policy/payment flow
- `viewer`: read-only experience on sensitive execution paths

### 4.3 Login Hardening

- Rate limiting
- Brute-force lockout (`FORTEXA_AUTH_MAX_ATTEMPTS`, `FORTEXA_AUTH_LOCK_MINUTES`)

### 4.4 Shared Enforcement Gate (decision / build / submit)

`POST /api/decision`, `POST /api/stellar/build-payment`, and `POST /api/stellar/submit-signed` share one enforcement gate (`src/lib/security/enforcement-gate.ts`) that runs before any side effect:

1. **Rate limit** — the caller's per-route budget is consumed atomically through the shared security state (Redis `EVAL` when `REDIS_URL` is set, file-backed otherwise), so parallel requests cannot both pass the last allowed slot.
2. **Blocklist** — the payment destination (and, on decision, the action domain) is checked against the `FORTEXA_BLOCKLIST_URL` feed. A destination blocked on one route is blocked on all three.

Denied requests return a stable machine-readable `code` alongside the usual rate-limit headers:

| Condition | HTTP | `code` |
|---|---|---|
| Destination or domain on the blocklist | `403` | `BLOCKLISTED` |
| Route rate budget exhausted | `429` | `RATE_LIMITED` |

Destination and domain values never appear in metrics labels.

> Note: MFA is removed from current implementation.

---

## 5) 👛 Wallet and Signing Model (Current)

Fortexa currently does **not perform server-side signing or private-key custody**.

- Session is wallet-bound at login.
- Execution source wallet is derived from session identity.
- Session wallet mappings expire automatically after 24 hours. Expired sessions will receive a `401 Unauthorized` response on protected endpoints.
- Operators can forcefully revoke a compromised or stale session mapping via `DELETE /api/auth/wallet/revoke`. This deterministically removes the mapping from storage, requiring the user to reconnect their wallet.
- Manual arbitrary wallet assignment in UI is removed.
- `/api/stellar/balance` auto-syncs missing wallet mapping from session when possible.

---

## 6) ⚙️ Decision and Payment Flow

### 6.1 Decisioning

- Policy engine: `src/lib/policy/engine.ts`
- Security analyzer: `src/lib/security/analyzer.ts`
- Decision engine: `src/lib/decision/engine.ts`

Decision outcomes:
- `BLOCK`
- `REQUIRE_APPROVAL`
- `WARN`
- `APPROVE`

`Human Approve & Re-run` applies only when prior result is `REQUIRE_APPROVAL`.

### 6.1a Policy Simulation (Pre-Save Safety Check)

Before committing a policy change, operators can dry-run the unsaved draft from the Policy editor (**Run simulation**). The draft is evaluated against the seeded demo scenarios — and, optionally, a small recent-audit sample — and the result shows each action's `current → proposed` decision so risky edits surface before they go live.

Simulation is strictly read-only: it never saves the policy and never consumes usage. Saving still happens only through `POST /api/policy`. See `src/lib/decision/simulate.ts` and `POST /api/policy/simulate`.

### 6.2 Signed XDR Payment Path

1. Evaluate action in `/console` with a **payment quote** (`paymentQuoteInput`: destination, optional memo, network). On `APPROVE`/`WARN`, Fortexa stores an immutable `paymentQuote` on the audit entry.
2. Build unsigned tx as a signer: `POST /api/stellar/build-payment` with `auditEntryId` plus the same destination, amount, asset, memo, and network. The server verifies every field against the authorized quote **before** constructing XDR.
3. `Submit Signed XDR` orchestrates signing/submission path:
   - if signed input is already present → submit directly
   - if unsigned input is present → wallet signing is triggered first, then submit
4. Submit signed tx: `POST /api/stellar/submit-signed` with the build response's `decisionId`, `quoteExpiresAt`, and `buildAuthorization` alongside `signedXdr`. Submit reloads the decision and rejects an expired quote or a build token that does not match the signed transaction.
5. Explorer URL is returned and shown as clickable link.

#### Quote-to-XDR trust boundary

The policy decision authorizes a fixed payment quote (destination, amount, asset, memo, network). `POST /api/stellar/build-payment` is the enforcement gate: it loads the audit entry by `auditEntryId`, confirms the decision is `APPROVE`/`WARN`, and rejects any request whose fields diverge from the stored quote.

| Condition | HTTP | Response |
|---|---|---|
| Missing/invalid body (`auditEntryId`, schema) | `400` | `Invalid payment build request.` + zod details |
| Unknown audit entry or non-executable decision | `403` | `No authorized payment decision found…` / `Decision 'BLOCK' does not authorize…` |
| Tampered destination, amount, asset, or memo | `403` | `{ error, field }` naming the mismatched field |
| Valid approved request | `200` | `{ ok: true, xdr, networkPassphrase, … }` |

Client-side UI must pass the same `paymentQuoteInput` at decision time and reuse the returned `auditEntry.id` both when building XDR and submitting it. Mutating any authorized field after approval cannot produce an executable transaction.

**Idempotent retries:** `POST /api/stellar/submit-signed` accepts an optional idempotency key, supplied either as an `Idempotency-Key` request header or an `idempotencyKey` body field (the header wins if both are present). Results are stored per authenticated user + key + signed-XDR hash. Replaying the same key with the same signed XDR returns the original result (`200`, with header `Idempotency-Replayed: true`) without resubmitting to Horizon. Reusing the same key with a different signed XDR returns `409 Conflict`. Omitting the key preserves the original submit-on-every-request behavior. Keys must be 8–255 characters.

Additional behavior:
- XDR build timeout configured to 180 seconds.
- Submit errors include Horizon result codes when available.

---

## 7) 📜 Audit and Evidence

- Decisions are appended to audit store at evaluation time.
- `/activity` reads entries by authenticated session user id.
- Export endpoint supports `mine` and `all` scopes in JSON/CSV.

### Hash chain integrity

Every new audit entry is linked into a tamper-evident SHA-256 hash chain:

| Field | Description |
|---|---|
| `previousHash` | `entryHash` of the immediately preceding entry, or `0000…0000` (64 zeroes) for the first hashed entry. |
| `entryHash` | SHA-256 of the entry's canonical fields (`id`, `timestamp`, `action`, `decision`, `explanation`, `triggeredPolicies`, `riskFindings`, `stellarTxHash`, `previousHash`). Object keys are sorted before hashing so DB-stored and file-stored entries produce identical digests. |

Both fields are included in JSON exports. CSV exports add `entryHash` and `previousHash` columns.

Verification helper: `verifyHashChain(entries)` in `src/lib/audit/hash-chain.ts` — returns `{ valid: true }` for an untouched log and `{ valid: false, reason }` when it detects a modified, deleted, or reordered entry.

Entries written before this feature was introduced carry no hash fields and are treated as **legacy** entries; they do not break verification of newer hashed entries.

#### CLI verifier

An exported JSON audit file can be verified outside the running application:

```bash
npm run verify:audit -- path/to/export.json
```

The script reads the JSON export, extracts the entries (handles `scope=mine` and `scope=all` formats), and runs the same `verifyHashChain` logic that the library uses. Exit code:

| Exit code | Meaning |
|---|---|
| `0` | All entries verified successfully |
| `1` | Chain integrity check failed (see stdout for details) |
| `2` | Usage error or file not readable |

Usage: `tsx scripts/verify-audit-export.ts <file>`

---

## 8) 🛠️ Local Setup

### Requirements
- Node.js 20+
- npm 10+

### Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open: `http://localhost:3000`

### Resetting Local Demo State

To clean up local developer state safely, you can use the local demo reset utility. This script is strictly for local environments and implements guardrails to prevent accidental cleanup of production/non-local databases.

#### Guardrails
- **Local Database Check**: Inspects `DATABASE_URL` and blocks execution if the hostname is not local (`localhost`, `127.0.0.1`, `::1`, or local UNIX sockets).
- **Explicit Confirmation**: Rejects execution unless **both** the environment variable `FORTEXA_ALLOW_LOCAL_RESET=true` and CLI flag `--yes` are provided.

#### Usage

* **Dry-Run (Default)**: Inspect what files and databases would be cleared without modifying any data.
  ```bash
  npm run demo:reset
  ```
  *(or `npx tsx scripts/reset-local-demo-state.ts`)*

* **Apply Reset**: Execute the state reset once all guardrails are met.
  ```bash
  FORTEXA_ALLOW_LOCAL_RESET=true npm run demo:reset -- --yes
  ```
  *(or `FORTEXA_ALLOW_LOCAL_RESET=true npx tsx scripts/reset-local-demo-state.ts --yes`)*

`.env.example` is intentionally development-oriented and uses Stellar testnet defaults, so it will not pass the production readiness check until you replace the demo values with production configuration.

---

## 9) 🌍 Environment Variables

Reference (`.env.example`):

```bash
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
# Optional; defaults to testnet passphrase. Must agree with STELLAR_HORIZON_URL.
STELLAR_NETWORK_PASSPHRASE=

DATABASE_URL=
DATABASE_SSL=false

FORTEXA_STORE_DIR=

FORTEXA_SHARED_STATE_PATH=
REDIS_URL=

GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile

FORTEXA_AUTH_SECRET=
FORTEXA_OPERATOR_WALLETS=
FORTEXA_SIGNER_WALLETS=
FORTEXA_VIEWER_WALLETS=
FORTEXA_AUTH_MAX_ATTEMPTS=5
FORTEXA_AUTH_LOCK_MINUTES=10
FORTEXA_JSON_BODY_MAX_BYTES=65536


# Optional: extra keys to redact from /api/audit/export payloads.
# Comma-separated. Matched case-insensitively. Useful for org-specific
# internal secret names.
# FORTEXA_AUDIT_EXPORT_SENSITIVE_KEYS=internalSecret,corpApiKey

NEXT_PUBLIC_STELLAR_DESTINATION=

# Optional: keys (comma-separated) treated as sensitive in audit export payloads.
# See §11.1 Audit Export Redaction.
# FORTEXA_AUDIT_EXPORT_SENSITIVE_KEYS=internalSecret,corpApiKey

# Optional external blocklist URL for dynamic threat-intel
# Accepts JSON array of domains or plain-text (one domain per line, # comments ignored)
# Cached in-memory for 5 minutes; feed failures fall back silently
FORTEXA_BLOCKLIST_URL=
```

---

## 10) ▶️ Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
npm test
npm run test:watch
npm run check:production-readiness
npm run check:env-duplicates
npm run demo:scenarios
npm run db:migrate
```

### Running the policy pack regression suite

The investor-facing scenario pack lives in `src/lib/scenarios/seed.ts` and its regression suite in `src/lib/scenarios/scenario-pack.test.ts`.

Run the full scenario pack:

```bash
npm test -- src/lib/scenarios/scenario-pack.test.ts
```

Run the standalone demo runner (prints expected vs actual for every seeded scenario):

```bash
npm run demo:scenarios
```

### Env example duplicate check

`npm run check:env-duplicates` reads `.env.example`, skips blank lines and full-line comments, and exits non-zero when a variable name is assigned more than once. The report lists each duplicate key with its line numbers. CI runs the same command.

### Production Readiness Check

Run this before every production deployment and before enabling protected payment flows:

```bash
npm run check:production-readiness
```

The readiness check validates:

- `STELLAR_HORIZON_URL`
- `STELLAR_NETWORK_PASSPHRASE`
- `FORTEXA_AUTH_SECRET`
- `FORTEXA_OPERATOR_WALLETS`
- `DATABASE_URL` or `FORTEXA_STORE_DIR`
- `REDIS_URL` or `FORTEXA_SHARED_STATE_PATH`

It also rejects unsafe demo/default values such as testnet Horizon endpoints, mismatched Stellar network settings, and local demo file-store paths without printing secret values.

Expected behavior:

- Success: prints `Fortexa production readiness check passed.` and exits `0`.
- Failure: prints `Fortexa production readiness check failed:` followed by the invalid setting and remediation for each issue, then exits non-zero.

Example success:

```bash
$ npm run check:production-readiness
Fortexa production readiness check passed.
```

Example failure:

```bash
$ npm run check:production-readiness
Fortexa production readiness check failed:
- STELLAR_NETWORK_PASSPHRASE: Testnet passphrase is still configured. Set STELLAR_NETWORK_PASSPHRASE to the Stellar public network passphrase before deployment.
- DATABASE_URL or FORTEXA_STORE_DIR: No persistent storage backend is explicitly configured. Configure DATABASE_URL for Postgres or set FORTEXA_STORE_DIR to a durable production storage path.
```

In `NODE_ENV=production`, Fortexa also applies this check before `/api/stellar/build-payment` and `/api/stellar/submit-signed` execute. If configuration is unsafe, those routes return `503` with a non-sensitive issue list and the remediation command instead of attempting the payment flow.

---

## 11) 🔌 API Surface (Reference)

JSON `POST` routes that accept request bodies enforce a shared size limit before parsing (default **64 KiB**, override with `FORTEXA_JSON_BODY_MAX_BYTES`). Oversized payloads receive HTTP **413** with a clear error message; malformed but small JSON still returns the route's normal validation error.

### Auth
- `POST /api/auth/challenge`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`
- `POST /api/auth/refresh`
- `DELETE /api/auth/wallet/revoke` (`operator`) — revokes session wallet mapping

### Policy
- `GET /api/policy`
- `POST /api/policy` (`operator`)
- `POST /api/policy/simulate` (`operator`) — read-only pre-save simulation
- `GET /api/policy/history` (`operator`)
- `POST /api/policy/rollback` (`operator`)
- `POST /api/policy/rollback/preview` (`operator`) — read-only rollback impact preview

### Decision / Planning
- `POST /api/decision` (`operator`)
- `POST /api/agent/plan` (`operator`, Groq-backed)

### Audit / Observability
- `GET /api/audit`
- `GET /api/audit/export?format=json|csv&scope=mine|all&from=<ISO8601>&to=<ISO8601>&decision=APPROVE|WARN|REQUIRE_APPROVAL|BLOCK&domain=<string>&actionId=<string>`
  - **Filters:** `from` / `to` (ISO 8601 date), `decision`, `domain`, `actionId` — all optional
  - **Scope:** `mine` (own entries) or `all` (operator only)
  - **Examples:**
    - `GET /api/audit/export?format=csv&scope=mine&from=2025-06-01T00:00:00Z&to=2025-06-30T23:59:59Z`
    - `GET /api/audit/export?format=json&scope=all&decision=BLOCK&domain=malicious.example.com`
    - `GET /api/audit/export?format=json&scope=mine&actionId=evt_abc123`
  - **Redaction:** All `format=json` and `format=csv` responses are passed through
    `src/lib/audit/redact.ts` *before* leaving the route — see
    [§11.1 Audit Export Redaction](#111-audit-export-redaction) below for the full
    contract (what is redacted, what is preserved, and how to extend it).
- `GET /api/health`
- `GET /api/metrics` (`?format=prometheus`)

### Stellar
- `GET /api/stellar/balance`
- `POST /api/stellar/setup` (session-wallet bootstrap/sync helper; not manual wallet linking)
- `POST /api/stellar/build-payment`
- `POST /api/stellar/submit-signed` (supports `Idempotency-Key` header/body for safe UI retries)
- `POST /api/stellar/pay` (legacy disabled)
- `POST /api/stellar/fund` (removed behavior, returns `410`)

### 11.1 Audit Export Redaction

Exported operator reports (`/api/audit/export`) are intended for sharing with reviewers
and external auditors. To make those reports safe to forward, every payload — JSON or
CSV, `scope=mine` or `scope=all` — is run through `redactAuditExportPayload`
(`src/lib/audit/redact.ts`) before it leaves the route. The goal is "useful but
non-leaky": reviewers can still see what was decided, why, and how Horizon responded,
but they never see raw secrets.

**What is always redacted** (replaced with a `{ "$redacted": "<reason>" }` placeholder):

| Reason            | Examples of redacted keys / values                                            |
| ----------------- | ---------------------------------------------------------------------------- |
| `session`         | `sessionKey`, `session_id`, `wallet_session`, `authSession`                  |
| `token`           | `token`, `accessToken`, `refreshToken`, `bearer`, `authorization`, `auth`, `jwt`, `access_token`, `refresh_token`, plus any value matching a JWT-shaped pattern |
| `signed_xdr`      | `signedXDR`, `signed_xdr`, `xdr`, `signature`, plus any value that starts with `XDR:`, contains `signed xdr`/`signed tx`, or is a long base64-ish block |
| `sensitive_field` | Anything that matches a configured sensitive key or pattern that doesn't fit a more specific bucket |

The redaction is recursive — nested objects, arrays, and unknown keys are walked
until the configured max depth (25). It also catches value-only matches: a JWT-shaped
string under a benign key (e.g. `note: "eyJ..."`) is still redacted.

**What is preserved (decision evidence):**

- `id`, `timestamp`
- `decision`, `explanation`
- `triggeredPolicies`, `riskFindings`
- `entryHash`, `previousHash` (the audit hash chain itself)
- `horizonResultCode`, `resultCode`, `opCodes`, `code`, `status`, `reason` — Horizon result codes are kept verbatim so operators can debug `tx_bad_seq`, `tx_insufficient_fee`, `op_no_destination`, `op_underfunded`, etc.
- `userId`, `exportedBy`, `scope` (the export envelope)
- CSV columns emitted by the route: `userId`, `id`, `timestamp`, `decision`, `actionId`, `actionName`, `domain`, `amountXLM`, `explanation`, `entryHash`, `previousHash`

**Why this matters for debugging policy and Horizon failures:**

- You can still see which scenario was evaluated, what the decision was, which policy
  triggers fired, which security findings were raised, and the SHA-256 hash chain.
- You can still see Horizon `tx_*` and `op_*` result codes.
- You can never accidentally ship a raw signed XDR, a session token, or a bearer
  header to a reviewer or a chat tool.

**Extending the redaction list:**

The redaction config supports a per-deployment env override
`FORTEXA_AUDIT_EXPORT_SENSITIVE_KEYS` (comma-separated). Add a key to that env var
and the redactor will treat it as sensitive for both JSON and CSV exports in that
environment.

```bash
# Example: redact any field named like an internal secret
FORTEXA_AUDIT_EXPORT_SENSITIVE_KEYS=internalSecret,corpApiKey
```

The redaction logic itself is unit-tested in `src/lib/audit/redact.test.ts` —
covering nested payloads, arrays, value-heuristic JWT/XDR matches, allowlisted
decision evidence, and pattern-based unknown keys — and the export route is
covered in `src/app/api/audit/export/route.test.ts`, which asserts that
`scope=all` JSON exports never contain raw `XDR:`, `Bearer ey…`, `sessionKey`,
or `signedXdr` strings.

---

## 12) 🗺️ Pages

- `/` → Overview dashboard
- `/login` → Wallet-only authentication (Connect Wallet)
- `/wallet` → Session wallet status and balance
- `/console` → Decisioning + payment execution console
- `/policies` → Policy editor, history, rollback
- `/scenarios` → Scenario gallery
- `/activity` → Audit trail timeline
- `/ops` → Operations/telemetry dashboard

---

## 13) 📈 Ops / Observability (Appendix)

- Health endpoint: `GET /api/health` — returns `blocklist` object with `configured`, `lastRefreshAt`, `domainCount`, `lastError`, plus `ready`, `checks`, and `failingChecks` (`production_config`, `storage`, `horizon`). The dashboard shows its pay, fund, and policy actions only while `ready` is `true`.
- Metrics endpoint: `GET /api/metrics` + Prometheus format
- `/ops` dashboard shows:
  - allow / deny / rate-limit / submit-failure counters, read from the same in-process metrics snapshot that `GET /api/metrics` exports (zeroes when nothing has been recorded yet)
  - service health
  - total requests
  - error rate
  - signed tx count
  - blocklist feed health (configured, domain count, last refresh, errors)
  - top routes + rolling trend

Ops dashboard initial load is optimized so core telemetry renders first; slow TX-count fetch no longer blocks first paint.

See [docs/observability.md](docs/observability.md) for the Prometheus scrape config, sample PromQL (request rate, error rate, p95 latency), and an example alert rule.

---

## 14) 💾 Persistence (Appendix)

### DB-first with File Fallback

Stores include:
- `audit-store`
- `policy-store`
- `user-wallet-store`
- `submit-idempotency-store`

If `DATABASE_URL` is available and healthy, Postgres is used.
Otherwise Fortexa falls back to local JSON files:
- local/dev default: `.fortexa/*.json`
- Vercel default: `/tmp/fortexa/*.json`

Optional overrides:
- `FORTEXA_STORE_DIR` to set file-store directory explicitly (the audit file store only opens paths that resolve inside this directory; `..`, absolute paths outside it, and symlinks leading out of it are refused with a `StoragePathError`)
- `FORTEXA_SHARED_STATE_PATH` for shared lockout/rate-limit state file path
  - use an absolute path on Vercel (example: `/tmp/fortexa/shared-security-state.json`)
- `REDIS_URL` for multi-instance deployments (e.g. Vercel)
  - uses a Redis-backed adapter with automatic, transparent fallback to the file store if Redis is unreachable or unconfigured.

### Versioned Migrations

- Migrations: `src/lib/storage/migrations.ts`
- Runner: `src/lib/storage/db.ts`
- Tracking table: `fortexa_schema_migrations`
- Manual run: `npm run db:migrate`

---

## 15) 🧱 Stack (Appendix)

- **Framework:** Next.js App Router (`next@16`)
- **Language:** TypeScript
- **UI:** Tailwind CSS + custom UI primitives
- **Validation:** `zod`
- **Charts:** `recharts`
- **Stellar:** `@stellar/stellar-sdk`, optional `@stellar/freighter-api`
- **Database:** `pg` (optional Postgres, file fallback enabled)
- **Tests:** Vitest

---

## 16) 🧪 Known Limitations (Current)

1. Shared security state supports Redis distributed locking, but defaults to file-based for local development.
2. Risk scoring remains heuristic-heavy (no external threat-intel integration).
3. Stellar workflow is testnet-oriented.
4. Server-side signing remains intentionally disabled.
5. Full end-to-end automated coverage for the complete decision-to-payment lifecycle is still limited.

Fortexa is intentionally optimized for hackathon clarity and wallet-native control, not full production deployment.

---

## 17) 🛡️ Decision Explanation Snapshot Tests

Reviewer-facing explanation text is guarded by snapshot tests to ensure transparency and prevent accidental explanation drift across changes.

**How to update snapshots:**
```bash
npm run test -- src/lib/decision/engine.scenarios.test.ts --updateSnapshot
```

**Files:**
- `src/lib/decision/engine.scenarios.test.ts` - Snapshot tests for decision explanations
- `src/lib/decision/engine.test.ts` - Updated summary file referencing the snapshots

**Covered decision types:**
- **APPROVE** - Safe research payment (human-readable approval message)
- **BLOCK** - Malicious endpoint blocked by domain policy
- **WARN** - Typosquat domain risk detected (caution warning)
- **REQUIRE_APPROVAL** - Over-budget transfer requiring manual approval

These snapshots make policy decision transparency reproducible for reviewers and protect against accidental explanation drift.

---

---

## 17) ❓ Troubleshooting Payment Failures

Common Stellar Horizon failures during the signed payment flow:

- **`tx_bad_seq`**: The transaction sequence number is incorrect. Wait for pending transactions to clear or refresh your wallet state.
- **`tx_insufficient_fee`**: The provided fee is below the current network minimum. Increase the base fee.
- **`op_no_destination`**: The destination account does not exist on the network. Verify the destination address.
- **`op_underfunded`**: Your source wallet lacks the XLM necessary to complete the payment and satisfy the network base reserve.

---

## 18) 🛣️ Practical Next Steps

- Add stronger risk intelligence + anomaly detection.
- Expand end-to-end payment verification and automated lifecycle tests.

---

## 19) 📄 License

MIT (see `package.json`).

All done
...
