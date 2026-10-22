# 🏗️ Fortexa Architecture

> This document describes the architecture **as currently implemented in this repository**, not an idealized target state.
> This file is intended for technical reviewers; see `README.md` for product framing and demo-first flow.

## 1) 🎯 System Purpose

Fortexa is a policy-controlled payment firewall for agent-triggered actions on Stellar.  
It inserts a decision layer between agent intent and transaction submission.

Core intent:

- authenticate users via wallet-bound session
- evaluate requested actions against policy + risk heuristics
- allow signed XDR submission only through authenticated operator flows
- preserve audit evidence for traceability

## 2) 📌 Scope and Non-Goals (Current)

### In scope

- Wallet challenge-signature login (`/api/auth/challenge` + `/api/auth/login`)
- Role-based route protection (`operator`, `viewer`)
- Policy + security-based decisioning
- Signed XDR submission to Stellar Testnet
- Audit/history persistence with DB-first fallback
- Basic health/metrics endpoints for ops visibility

### Explicit non-goals (current code)

- Server-side signing
- Private-key custody
- Mainnet-first transaction flow
- Distributed, strongly consistent security state by default

## 3) 🧭 High-Level Topology

### 3.1 Runtime Container View

```mermaid
flowchart LR
  UI[Next.js App UI\n/pages + client components] --> API[Next.js API Routes]

  API --> AUTH[Auth + Session]
  API --> DEC[Decision Engine]
  API --> POL[Policy Store]
  API --> AUD[Audit Store]
  API --> STELLAR[Stellar Client]
  API --> OBS[Metrics + Logs]

  POL --> DB[(Postgres if available)]
  AUD --> DB
  AUTH --> DB

  POL --> FILE[JSON fallback\nlocal .fortexa / Vercel /tmp/fortexa]
  AUD --> FILE
  AUTH --> FILE

  STELLAR --> HZN[Horizon Testnet]
  API --> GROQ[Groq API /agent/plan]
```

### 3.2 Trust Boundary View

```mermaid
flowchart TB
  subgraph Untrusted[Untrusted Zone]
    Browser[Browser + User Input]
    WalletExt[Wallet Extension\n(Freighter etc.)]
  end

  subgraph AppBoundary[Fortexa Application Boundary]
    WebUI[Next.js UI]
    ApiRoutes[API Routes + Validation]
    Authz[Session + Role Authorization]
    Decisioning[Policy + Risk Decisioning]
    Storage[DB/File Persistence]
    Observability[Metrics + Logs]
  end

  subgraph External[External Systems]
    Horizon[Stellar Horizon Testnet]
    Groq[Groq API]
  end

  Browser --> WebUI
  WebUI --> ApiRoutes
  ApiRoutes --> Authz
  ApiRoutes --> Decisioning
  ApiRoutes --> Storage
  ApiRoutes --> Observability
  WebUI <-- signed XDR --> WalletExt
  ApiRoutes --> Horizon
  ApiRoutes --> Groq
```

## 4) 🧩 Runtime Building Blocks

- `src/app/api/auth/*`: wallet login, session issue/refresh/logout/session lookup.
- `src/lib/auth/session.ts`: signed cookie session token (`fortexa_session`).
- `src/lib/auth/require-auth.ts`: role-based auth guard for protected APIs.
- `src/app/api/decision/route.ts`: evaluates action, applies optional human-approval override, appends audit record.
- `src/app/api/policy/simulate/route.ts`: read-only pre-save check; compares current vs proposed policy decisions without persisting.
- `src/lib/decision/engine.ts`: combines policy checks + risk findings into decision outcome.
- `src/lib/decision/simulate.ts`: pure helper that evaluates demo scenarios + a recent-audit sample against current and proposed policy.
- `src/lib/policy/engine.ts`: deterministic policy rules (caps, tools, domains, hours, thresholds).
- `src/lib/security/analyzer.ts`: heuristic risk findings + risk score.
- `src/app/api/stellar/build-payment/route.ts`: builds unsigned TESTNET payment XDR.
- `src/app/api/stellar/submit-signed/route.ts`: submits signed XDR, returns tx hash + explorer link.
- `src/lib/stellar/client.ts`: Horizon calls, XDR construction, XDR submission.
- `src/lib/storage/*-store.ts`: policy/audit/user-wallet/submit-idempotency persistence with DB fallback.
- `src/lib/storage/submit-idempotency-store.ts`: claims an idempotency key before submit, stores the accepted status + transaction id for replay, and rejects a reused key with a different canonical payment body.
- `src/lib/storage/atomic-write.ts`: atomic JSON store writes (unique staging file + rename).
- `src/lib/storage/db.ts`: optional Postgres connector + migration bootstrap + graceful fallback.
- `src/app/api/metrics/route.ts` + `src/lib/observability/metrics.ts`: JSON and Prometheus metrics.

## 5) 🔄 Primary Request Flows

### 5.1 Wallet Challenge-Signature Login

1. Client posts wallet `publicKey` to `/api/auth/challenge`.
2. Server returns `challengeId`, `message`, and `expiresAt` (one-time, short-lived).
3. Client signs the challenge message with the wallet (SEP-53 via Freighter `signMessage`).
4. Client posts `publicKey`, `challengeId`, and `signature` to `/api/auth/login`.
5. Server verifies signature, enforces challenge expiry + one-time use, then resolves role via allowlists.
6. Lockout + rate-limit checks apply on login verification failures.
7. Session token is issued in `fortexa_session` cookie.
8. Wallet mapping is upserted for that `userId`.

Honest note: if both allowlists are empty, current behavior allows any valid wallet as `operator` (developer-friendly, not production-safe).

```mermaid
sequenceDiagram
  autonumber
  participant U as User/Browser
  participant CH as /api/auth/challenge
  participant API as /api/auth/login
  participant RL as Rate Limit + Lockout
  participant AUTH as Session Signer
  participant UW as user-wallet-store

  U->>CH: POST { publicKey }
  CH-->>U: challengeId + message + expiresAt
  U->>U: signMessage(challenge) via Freighter
  U->>API: POST { publicKey, challengeId, signature }
  API->>RL: consumeRateLimit + isLoginLocked
  alt Limited or locked
    RL-->>API: deny
    API-->>U: 429/423 + headers
  else Allowed
    API->>API: verify challenge + SEP-53 signature
    alt Invalid/expired/replayed challenge or bad signature
      API->>RL: register failure (bad signature)
      API-->>U: 400/401
    else Signature verified
      API->>API: resolve role via allowlists
      alt Unauthorized wallet
        API->>RL: register failure
        API-->>U: 401
      else Authorized wallet
        API->>UW: upsertUserWallet(userId, publicKey)
        API->>AUTH: createSessionToken(userId, role)
        API-->>U: 200 + fortexa_session cookie
      end
    end
  end
```

### 5.2 Decision Evaluation

1. Authenticated operator calls `/api/decision`.
2. Request is schema-validated.
3. Policy is loaded (`policy-store`) and current usage is loaded (`audit-store`).
4. Decision engine computes `BLOCK | REQUIRE_APPROVAL | WARN | APPROVE`.
5. Optional `approvedByHuman` can elevate `REQUIRE_APPROVAL` to `APPROVE`.
6. Usage is consumed only for `APPROVE`/`WARN`.
7. Audit entry is persisted.

### 5.2a Policy Simulation (Pre-Save Safety Check)

Operators can dry-run an unsaved policy draft before committing it, so the impact of a change is visible up front.

1. Operator edits the policy in the UI and clicks **Run simulation** (optionally including a recent-audit sample).
2. The draft is posted to `/api/policy/simulate` and schema-validated.
3. The route loads read-only snapshots of the current policy (`policy-store`) and usage (`audit-store`); it builds cases from the seeded demo scenarios and, optionally, the newest few audit actions for that operator.
4. `simulatePolicyChange` evaluates each action against **both** the current and proposed policy and reports `current → proposed` decisions plus a changed-count summary.
5. Nothing is written: the policy is not saved and usage is not consumed. Saving still happens only via `/api/policy`.

The audit sample is intentionally small and deterministic (newest-first, capped) to keep simulations cheap and reviewable.

### 5.2b Candidate Decision Impact (History Read)

Operators can see which currently allowed payments a candidate policy version would turn into a denial — and which rule is responsible — before that version is activated.

1. `GET /api/policy/history?candidate=<version>` loads the active policy and the candidate version from `policy-store` (read-only).
2. `openAllowDecisions` collects the open allow decisions from the audit history (the newest recorded result per action, when that result is `APPROVE`/`WARN`).
3. `diffDecisionImpact` (`src/lib/validation/diff.ts`) diffs the candidate against the active policy by rule id, re-runs each open allow through the decision engine under both policies, and walks the changed rules one at a time to attribute the flip to a single rule id.
4. The response reports `flippedIds`, the responsible `ruleId` per flip, and a `status` of `decision change` or `no decision change`.

Nothing is written: the candidate is never activated and usage is never consumed. Saving still happens only via `POST /api/policy` (or `POST /api/policy/rollback`).

### 5.3 Signed Payment Submission

1. Build unsigned transaction via `/api/stellar/build-payment`.
2. User signs in external wallet (e.g., Freighter).
3. Signed XDR is sent to `/api/stellar/submit-signed`.
4. API validates input and auth (`operator`), submits to Horizon Testnet.
5. Response includes tx hash, ledger, and testnet explorer URL.

Honest note: no server-held secret signs transactions.

```mermaid
sequenceDiagram
  autonumber
  participant U as Operator UI
  participant BP as /api/stellar/build-payment
  participant W as Wallet Extension
  participant SS as /api/stellar/submit-signed
  participant H as Horizon Testnet

  U->>BP: POST payment request
  BP-->>U: unsigned XDR
  U->>W: request signature(unsigned XDR)
  W-->>U: signed XDR
  U->>SS: POST signedXdr
  SS->>H: submitTransaction
  alt Horizon success
    H-->>SS: hash, ledger, result_xdr
    SS-->>U: 200 + explorerUrl
  else Horizon failure
    H-->>SS: error + result_codes
    SS-->>U: 500 + parsed tx/op codes
  end
```

### 5.4 `/api/stellar/setup` Role

`/api/stellar/setup` currently acts as a **session-wallet bootstrap/sync helper**.  
It does not enable arbitrary manual wallet linking; it syncs the wallet already present in session context.

## 6) 💾 Data and Persistence Model

### 6.1 Stores

- `policy-store`: policy config + version history
- `audit-store`: per-user audit records + daily usage counters
- `user-wallet-store`: user-to-wallet mapping

```mermaid
erDiagram
  FORTEXA_POLICY_STATE ||--o{ FORTEXA_POLICY_HISTORY : versions
  FORTEXA_USAGE ||--o{ FORTEXA_AUDIT_ENTRIES : per_user

  FORTEXA_POLICY_STATE {
    int id PK
    int version
    timestamptz updated_at
    jsonb policy
  }

  FORTEXA_POLICY_HISTORY {
    int version PK
    timestamptz updated_at
    text updated_by
    jsonb policy
  }

  FORTEXA_USAGE {
    text user_id PK
    numeric spent_xlm
    int tool_calls
    timestamptz last_updated
  }

  FORTEXA_AUDIT_ENTRIES {
    uuid id PK
    text user_id
    timestamptz timestamp
    jsonb payload
    text entry_hash
  }

  FORTEXA_USER_WALLETS {
    text user_id PK
    text public_key
    text source
    text provider
    timestamptz updated_at
  }
```

### 6.2 Audit Hash Chain

Each audit entry appended via `appendAuditEntry` is enriched with two fields before persistence:

- **`previousHash`** — the `entryHash` of the most recent already-stored entry for the same user, or the 64-zero genesis sentinel (`0000…0000`) if no prior hashed entry exists.
- **`entryHash`** — a SHA-256 hex digest computed over a canonicalized JSON object that includes `id`, `timestamp`, `action`, `decision`, `explanation`, `triggeredPolicies`, `riskFindings`, `stellarTxHash`, and `previousHash`. All object keys are sorted before hashing to guarantee DB-stored and file-stored entries produce identical digests.

The `entry_hash` column on `FORTEXA_AUDIT_ENTRIES` (migration `002_audit_hash_chain`) holds this value for fast lookup of the previous hash during inserts.

**Verification** — `verifyHashChain(entries, boundaries?)` (`src/lib/audit/hash-chain.ts`):

1. Sorts entries chronologically by `timestamp`.
2. Skips entries without `entryHash`/`previousHash` (legacy, pre-chain entries).
3. For each hashed entry, checks that `previousHash` equals the preceding hashed entry's `entryHash` (or `GENESIS_HASH` for the first).
4. Recomputes `entryHash` from current field values and compares to the stored value.
5. When an export includes `chainBoundary` (or `chainBoundariesByUser` for an all-user export), checks the expected first and last hashes. A declared first boundary also allows verification of filtered segments whose first `previousHash` is not the genesis sentinel.
6. Returns `{ valid: false, reason, entryId }` on the first violation found.

This detects:

- **Modified entries** — any field change invalidates `entryHash`.
- **Deleted entries** — the next entry's `previousHash` no longer matches; explicit export boundaries also detect deletion of the first or last exported record.
- **Reordered entries** — the chain order breaks even if timestamps are adjusted.

Limitations: the chain is append-only tamper evidence, not a cryptographically signed ledger. An adversary with full write access to the store can rewrite the entire chain. The design goal is detection of unintended or casual tampering, not adversarial forgery.

### 6.3 DB-first fallback behavior

- If `DATABASE_URL` is set and DB is reachable: uses Postgres tables.
- On DB unavailability or operation failure: falls back to local JSON files.
  - local/dev default: `.fortexa/`
  - Vercel default: `/tmp/fortexa/`
  - optional override: `FORTEXA_STORE_DIR`

This fallback is intentional for local resilience, but introduces consistency tradeoffs in multi-instance deployments.

### 6.4 Migrations

- Migration definitions: `src/lib/storage/migrations.ts`
- Runtime bootstrap: `src/lib/storage/db.ts`
- Script: `npm run db:migrate`

### 6.5 Policy Payload Resilience Contract

Stored policy JSON (current state + history) can outlive the active schema. To prevent silent corruption when `policyConfigSchema` evolves:

- Valid current payloads parse unchanged.
- Older payloads missing _only_ documented optional fields are migrated by `parseStoredPolicy` (`src/lib/policy/migrations.ts`), which fills the safe defaults listed in `OPTIONAL_DEFAULTS` and reports the exact set of migrations applied.
- Malformed payloads (wrong types, unsafe values, mixes of missing-optional and non-rectifiable issues) fail closed with a structured `{ ok: false, error, issues }` result. Every Zod issue is surfaced with its path and message — no defaults are silently substituted for non-optional fields.
- The strict schema is never weakened for backwards compatibility. Migrating a new optional field is an explicit one-line change to `OPTIONAL_DEFAULTS` plus a corresponding fixture under `src/lib/policy/__fixtures__/`.
- `parseStoredPolicy` is a pure helper: it does not read or rewrite `.fortexa/` policy files. Callers decide whether to persist a migrated policy, reject one, or surface the error.
- Smoke coverage lives at `src/lib/policy/migrations.test.ts`.

## 7) 🔐 Security and Trust Boundaries

### 7.1 Trust boundaries

- Browser/UI is untrusted input surface.
- API routes enforce schema validation + auth.
- Session cookie is signed; authz is checked per protected route.
- Stellar signature material remains client-side in external wallet.
- Horizon/Groq are external dependencies.

### 7.2 Controls present in code

- Per-route rate limiting (`src/lib/security/rate-limit.ts`)
- Shared enforcement gate for money-movement routes (`src/lib/security/enforcement-gate.ts`): `/api/decision`, `/api/stellar/build-payment`, and `/api/stellar/submit-signed` consume the caller's rate budget atomically (Redis EVAL script or file read-modify-write via shared state) and check the destination — and, on decision, the action domain — against the threat-intel blocklist **before** policy evaluation, XDR construction, or Horizon submission. A destination blocked on one route is blocked on all three. Denials carry stable machine-readable codes: `BLOCKLISTED` (403) and `RATE_LIMITED` (429). Destination/action-domain values never enter metrics labels.
- Login lockout on repeated failures (`src/lib/auth/login-lockout.ts`)
- Optional shared file-backed state (`FORTEXA_SHARED_STATE_PATH`) for cross-process limiter/lockout state
- Role gating (`requireAuth`) for sensitive APIs

### 7.3 Controls not present (yet)

- No Redis-backed distributed rate limiter by default
- No HSM/KMS signing flow (intentionally)
- No advanced fraud intelligence feed integration

### 7.4 Decision State Machine (Implemented Behavior)

```mermaid
stateDiagram-v2
  [*] --> Evaluate
  Evaluate --> BLOCK: policy/risk hard fail
  Evaluate --> REQUIRE_APPROVAL: threshold crossed
  Evaluate --> WARN: soft concerns
  Evaluate --> APPROVE: clean pass

  REQUIRE_APPROVAL --> APPROVE: approvedByHuman=true
  REQUIRE_APPROVAL --> REQUIRE_APPROVAL: no manual approval

  WARN --> Audited
  APPROVE --> Audited
  BLOCK --> Audited
  REQUIRE_APPROVAL --> Audited

  Audited --> [*]
```

## 8) 📈 Observability Model

- Structured request-aware responses/log context via `jsonWithRequestContext` and logger utilities
- `/api/health` for health checks
- `/api/metrics` for JSON snapshot
- `/api/metrics?format=prometheus` for scrape-compatible format
- Ops UI renders the same in-process snapshot: `src/app/settings/page.tsx` (Ops tab, also reached via `/ops`) reads `getMetricsSnapshot()` on the server and hands it to `src/components/ops-dashboard.tsx`, so screen and scrape cannot disagree

## 9) 🚨 Failure Modes and Current Behavior

- **DB down or flaky:** storage layer logs warning and falls back to file store.
- **Horizon rejection:** submit endpoint returns enriched error with result codes when available.
- **Auth failures:** role/auth errors short-circuit protected routes.
- **Rate limit exceeded:** API returns `429` with rate-limit headers.
- **Invalid session wallet state:** setup/balance flows return validation errors or require resync.

## 10) 🧪 Architecture Limitations (Honest)

1. Deployment model is still effectively single-node oriented unless external shared state is configured.
2. Shared security state is file-backed, not distributed by default.
3. Decision risk scoring is heuristic and policy-driven, not ML threat-intel driven.
4. Transaction flow is testnet-centric (`Networks.TESTNET`, testnet explorer links).
5. End-to-end automated coverage for full decision-to-payment lifecycle is still limited.

## 11) 🛣️ Practical Evolution Path

Near-term, high-impact improvements:

- move limiter/lockout shared state to Redis for true multi-instance consistency
- add deeper post-submit reconciliation and payment state tracking
- expand full-path integration/e2e coverage across decision + signing + submission + audit

---

If this file and `README.md` disagree, treat this file as implementation-level detail and update both together in the same PR.
