# Security Changelog

This document records security-relevant architectural, policy, and behavioral changes across Fortexa. All changes affecting authentication, authorization, policy enforcement, cryptographic audit trails, and payment security must be documented here.

---

## 📋 Changelog Entry Guidelines for Contributors

When introducing a change that affects security behavior:
1. **Scope:** Add an entry under the corresponding domain (`Auth`, `Policy`, `Audit`, or `Payment`).
2. **Category:** Use one of the standard change types:
   - `[SECURITY ADDED]` - New security controls, guards, or rate limits.
   - `[SECURITY CHANGED]` - Modifications to security thresholds, validation rules, or error responses.
   - `[SECURITY FIXED]` - Remediation of vulnerabilities, parsing gaps, or logic flaws.
   - `[SECURITY REMOVED]` - Deprecation or removal of legacy/insecure interfaces.
3. **Evidence:** Reference the associated issue/PR and test verification suite.

---

## [Current Baseline] - 2026-10-23

### Auth (Authentication & Session Security)
- **[SECURITY ADDED] Wallet-Bound Authentication:** Login (`POST /api/auth/login`) requires cryptographic challenge signing using Stellar SEP-53 message signatures; arbitrary wallet assignment without signing is rejected.
- **[SECURITY ADDED] Replay & Timing Defense:** Auth challenges enforce strict TTL bounds (`FORTEXA_AUTH_CHALLENGE_TTL_SECONDS`) and one-time nonce consumption to prevent challenge replay attacks.
- **[SECURITY ADDED] Session Integrity:** Sessions are issued via HMAC-signed `fortexa_session` HTTP-only cookies with `SameSite=Lax` and secure flags.
- **[SECURITY ADDED] Role-Based Access Control:** Dual-role authorization matrix enforces `operator` (execution and write permissions) vs `viewer` (read-only monitoring).
- **[SECURITY ADDED] Brute-Force Lockout:** Login routes enforce exponential backoff and bounded IP rate limiting with deterministic lockout thresholds (`FORTEXA_AUTH_MAX_ATTEMPTS`, `FORTEXA_AUTH_LOCK_MINUTES`).
- **[SECURITY ADDED] Session Revocation:** Operators can forcefully revoke active wallet-to-session mappings via `DELETE /api/auth/wallet/revoke`.

### Policy (Policy Enforcement & Drift Protection)
- **[SECURITY ADDED] Deterministic Policy Engine:** Transaction proposals are evaluated through a policy engine (`src/lib/policy/engine.ts`) enforcing spend caps, velocity limits, and destination rules.
- **[SECURITY ADDED] Schema Validation & Tamper Resistance:** Policies are validated against strict Zod schemas with version migration tracking to reject malformed or unknown fields.
- **[SECURITY ADDED] Rollback Conflict Detection:** Policy rollback operations provide conflict preview analysis (`/api/policy/rollback/preview`) to detect schema drift before activation.
- **[SECURITY ADDED] Safe Decision Parity:** Simulation engine (`src/lib/decision/simulate.ts`) guarantees decision parity with live evaluation gates to prevent sandbox drift.

### Audit (Cryptographic Audit Trail & Redaction)
- **[SECURITY ADDED] SHA-256 Hash Chaining:** Audit entries are cryptographically linked in an append-only SHA-256 hash chain (`src/lib/storage/audit-store.ts`) where each entry commits to the preceding hash.
- **[SECURITY ADDED] Hash Chain Integrity Verification:** Exposes direct verification route (`GET /api/audit/integrity`) and pre-export chain validation to abort exports on missing or tampered records.
- **[SECURITY ADDED] Sensitive Data Redaction Gate:** Automated redaction gate (`src/lib/audit/redact.ts`) scrubs private keys, bearer tokens, session secrets, and raw signed XDR payloads before exporting.
- **[SECURITY ADDED] Path Traversal Defense:** Audit storage restricts file operations to bounded store directories (`FORTEXA_STORE_DIR`), rejecting directory traversal (`..`) attempts.

### Payment (Stellar Transaction Safety)
- **[SECURITY ADDED] Quote-Locked Execution:** Building unsigned payment XDR (`POST /api/stellar/build-payment`) strictly requires quote agreement from an approved, immutable audit entry; destination, amount, and asset cannot be tampered with between decision and build.
- **[SECURITY ADDED] Zero Private Key Custody:** Server strictly builds unsigned transaction envelopes; signing is exclusively performed client-side in the user's Freighter wallet.
- **[SECURITY ADDED] Shared Enforcement Gate:** Payment routes pass through a shared security gate (`src/lib/security/enforcement-gate.ts`) checking destinations against the remote blocklist feed (`FORTEXA_BLOCKLIST_URL`).
- **[SECURITY ADDED] Idempotent Broadcast:** Transaction submission (`POST /api/stellar/submit-signed`) guards against duplicate broadcast replay using distributed idempotency keys.
