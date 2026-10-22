# API Authorization Matrix

This document is the single source of truth for authorization requirements across all Fortexa API routes. It is maintained alongside the route implementations and must be updated whenever routes or roles change.

## Authorization Model

Fortexa uses two roles:

| Role         | Description                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------- |
| **operator** | Full access — can read and write policy, trigger decisions, build and submit Stellar transactions |
| **viewer**   | Read-only access — can read policy and audit entries, but cannot modify state                     |

Session tokens are signed HMAC-SHA256 cookies (`fortexa_session`) carrying a generation counter that is checked against the server-side session store. Unauthenticated requests (no valid cookie) receive **401 Unauthorized**. Authenticated requests with an insufficient role receive **403 Forbidden**.

---

## Route Inventory

### Authentication Routes

| Method | Route                 | Access Level     | Unauthenticated           | Viewer | State-Changing        | Notes                                                                                                                    |
| ------ | --------------------- | ---------------- | ------------------------- | ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/auth/challenge` | Public           | 200 (challenge issued)    | 200    | No                    | Issues a SEP-53 wallet challenge; rate-limited                                                                           |
| POST   | `/api/auth/login`     | Public           | 200 (sets session cookie) | 200    | Yes                   | Verifies wallet signature; sets `fortexa_session` cookie                                                                 |
| POST   | `/api/auth/logout`    | Public           | 200 (clears cookie)       | 200    | Yes                   | Revokes the presented session id server-side (every token generation of that login) and clears the cookie; no auth check |
| POST   | `/api/auth/refresh`   | operator, viewer | 401                       | 200    | Yes (refreshes token) | Requires valid, non-revoked session; extends token TTL and keeps the session id                                          |
| GET    | `/api/auth/session`   | Public           | 200 (no session body)     | 200    | No                    | Returns session metadata if the cookie verifies and its session id is not revoked; safe to call unauthenticated          |

### Health & Metrics Routes

| Method | Route          | Access Level  | Unauthenticated | Viewer | State-Changing | Notes                                                                                                                                 |
| ------ | -------------- | ------------- | --------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`  | Public        | 200             | 200    | No             | Returns service health, env flags, and the `ready`/`failingChecks` readiness verdict the dashboard gates actions on; no auth required |
| GET    | `/api/metrics` | operator only | 401             | 403    | No             | Returns Prometheus or JSON metrics snapshot                                                                                           |

### Audit Routes

| Method | Route               | Access Level     | Unauthenticated | Viewer                | State-Changing | Notes                                                                                    |
| ------ | ------------------- | ---------------- | --------------- | --------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| GET    | `/api/audit`        | operator, viewer | 401             | 200                   | No             | Lists audit entries for the authenticated user                                           |
| GET    | `/api/audit/export` | operator, viewer | 401             | 200 (scope=mine only) | No             | Exports audit entries; viewers restricted to `scope=mine`; operators may use `scope=all` |

### Decision Routes

| Method | Route           | Access Level  | Unauthenticated | Viewer | State-Changing | Notes                                                                         |
| ------ | --------------- | ------------- | --------------- | ------ | -------------- | ----------------------------------------------------------------------------- |
| POST   | `/api/decision` | operator only | 401             | 403    | Yes            | Evaluates an AI-policy decision; appends an audit entry; consumes daily usage |

### Policy Routes

| Method | Route                  | Access Level     | Unauthenticated | Viewer | State-Changing | Notes                                                   |
| ------ | ---------------------- | ---------------- | --------------- | ------ | -------------- | ------------------------------------------------------- |
| GET    | `/api/policy`          | operator, viewer | 401             | 200    | No             | Returns current active policy configuration             |
| POST   | `/api/policy`          | operator only    | 401             | 403    | Yes            | Replaces the active policy configuration                |
| POST   | `/api/policy/simulate` | operator only    | 401             | 403    | No             | Simulates a policy change against historical audit data |
| GET    | `/api/policy/history`  | operator only    | 401             | 403    | No             | Returns policy version history                          |
| POST   | `/api/policy/rollback` | operator only    | 401             | 403    | Yes            | Rolls back policy to a prior version                    |

### Stellar Routes

| Method | Route                        | Access Level     | Unauthenticated | Viewer | State-Changing           | Notes                                                                                             |
| ------ | ---------------------------- | ---------------- | --------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/stellar/balance`       | operator, viewer | 401             | 200    | No                       | Returns XLM balance for the authenticated user's linked wallet                                    |
| POST   | `/api/stellar/setup`         | operator, viewer | 401             | 200    | Yes                      | Links a Stellar wallet to the current user session                                                |
| POST   | `/api/stellar/build-payment` | signer only      | 401             | 403    | No (builds unsigned XDR) | Constructs an unsigned Stellar payment transaction; requires a prior authorized audit entry       |
| POST   | `/api/stellar/submit-signed` | signer only      | 401             | 403    | Yes                      | Requires the audit entry ID and a signed native payment matching its unexpired APPROVE/WARN quote |
| POST   | `/api/stellar/pay`           | signer only      | 401             | 403    | Yes                      | **Disabled** — direct payment remains unavailable                                                 |
| POST   | `/api/stellar/fund`          | operator, viewer | 401             | 200    | Yes                      | **Deprecated** — returns 410 Gone                                                                 |

### Agent Routes

| Method | Route             | Access Level  | Unauthenticated | Viewer | State-Changing | Notes                                      |
| ------ | ----------------- | ------------- | --------------- | ------ | -------------- | ------------------------------------------ |
| POST   | `/api/agent/plan` | operator only | 401             | 403    | No             | Generates an AI agent action plan via Groq |

---

## High-Risk Route Summary

The following routes carry the highest authorization risk because they can trigger financial operations or expose sensitive audit data.

| Route                             | Risk | Why                                                                           |
| --------------------------------- | ---- | ----------------------------------------------------------------------------- |
| `POST /api/decision`              | High | Appends permanent audit entries; consumes daily XLM usage quota               |
| `POST /api/policy`                | High | Replaces active policy; controls all subsequent decision outcomes             |
| `POST /api/policy/rollback`       | High | Reverts policy to a past version; can re-expose previously blocked behaviors  |
| `GET /api/audit/export`           | High | Bulk data export; operator can access all users' entries via `scope=all`      |
| `POST /api/stellar/build-payment` | High | Constructs unsigned Stellar payment transactions; gated by quote verification |
| `POST /api/stellar/submit-signed` | High | Broadcasts signed Stellar transactions to the network; irreversible           |

---

## Authorization Decision Flow

```
Request
  │
  ├─ Rate limit check (per-route limits, 15–40 req/min)
  │    └─ 429 Too Many Requests if exceeded
  │
  ├─ requireAuth(request, options?)
  │    ├─ No valid session cookie → 401 Unauthorized
  │    └─ Role not in allowedRoles  → 403 Forbidden
  │
  └─ Route handler (session guaranteed valid)
```

---

## Maintenance Notes

- `requireAuth()` defaults to `allowedRoles: ["operator", "viewer"]` when no options are passed.
- Adding a new protected route: call `requireAuth(request, { allowedRoles: [...] })` and add a row to this matrix.
- The `FORTEXA_AUTH_SECRET` environment variable must be set; without it, no session tokens can be verified.
- Role assignment is controlled by `FORTEXA_OPERATOR_WALLETS`, `FORTEXA_SIGNER_WALLETS`, and `FORTEXA_VIEWER_WALLETS` (comma-separated Stellar public keys). A wallet may appear in both operator and signer lists to receive both roles.
