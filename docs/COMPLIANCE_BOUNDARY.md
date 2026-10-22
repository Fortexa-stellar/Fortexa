# Compliance Boundary & System Safeguards

This document defines the engineering and compliance boundary for Fortexa. It outlines Fortexa's role as a policy evaluation and approval proxy layer, details system responsibilities, mapping to key code paths, and provides guides for investor communications and legal counsel.

---

## 1. Core Architectural Boundary

Fortexa is **not a custodian** of funds and does **not manage private keys**. It operates strictly as a policy, safety, and evaluation gatekeeper between AI agents and financial networks.

### Custody and Transaction Signing

- **No Private Key Access:** Fortexa's database, memory, and application servers never ingest, store, or process private keys (such as Stellar secret keys beginning with `S`).
- **Non-Custodial Design:** Transaction signing is always delegated to the user's secure wallet client (e.g., Freighter) or an external key management system controlled by the operator.
- **XDR Generation only:** The system evaluates agent requests and generates unsigned Transaction XDR payloads for operator review.
- **No Automatic Signing:** The server receives signed XDR payloads back from the client side and submits them to the network, but it cannot sign or modify them.

---

## 2. Technical Mapping to Code Paths

The functional boundaries described in this document correspond directly to the following codebase modules:

### 1. Authentication and Authorization Role Limits

Fortexa restricts high-privilege operations (like submitting signed transactions) to authenticated operators.

- **Auth Guard:** [`src/lib/auth/require-auth.ts`](../src/lib/auth/require-auth.ts) implements the role restriction logic (`operator` vs `viewer`).
- **Session Management:** [`src/lib/auth/session.ts`](../src/lib/auth/session.ts) parses the secure session context.

### 2. Policy & Security Decision Engine

Decisions are evaluated dynamically based on configured thresholds and rules.

- **Decision Handler:** [`src/lib/decision/engine.ts`](../src/lib/decision/engine.ts) orchestrates both security scans and rule matching to produce a decision (`APPROVE`, `WARN`, `REQUIRE_APPROVAL`, `BLOCK`).
- **Rule Engine:** [`src/lib/policy/engine.ts`](../src/lib/policy/engine.ts) validates parameters like per-transaction limits, daily budget caps, and allowed hours.

### 3. Cryptographic Audit Trail

Fortexa builds a tamper-evident chain of audit records to verify historic approvals.

- **Hash Chain Verification:** [`src/lib/audit/hash-chain.ts`](../src/lib/audit/hash-chain.ts) calculates recursive SHA-256 digests (`computeEntryHash`) linking each new decision block to the previous entry, preventing history modification or deletion.

### 4. Stellar Transaction Submission

Fortexa constructs transactions and submits user-signed envelopes.

- **Horizon Client Bridge:** [`src/lib/stellar/client.ts`](../src/lib/stellar/client.ts) generates unsigned transaction envelopes (`buildUnsignedPaymentTransaction`) and handles submission of user-signed envelopes (`submitSignedTransactionXdr`).
- **Submit API Route:** [`src/app/api/stellar/submit-signed/route.ts`](../src/app/api/stellar/submit-signed/route.ts) exposes the endpoint executing the submittal, wrapped in rate-limiting and idempotency protections.

---

## 3. Data Minimization & Sensitive Field Redaction

To preserve operator and counterparty privacy, Fortexa enforces data minimization principles when writing to persistent logs or the cryptographic audit chain:

- **Sensitive Redaction:** No raw prompt inputs or detailed agent conversation history are persisted directly in the audit trail.
- **Metadata Focus:** Only structured logs of policy triggers, risk scores, transfer amounts, source/destination public keys, and result statuses are logged.
- **Local Storage Option:** All audit databases can be self-hosted by the operator to prevent exposure of transaction history to third-party endpoints.

---

## 4. Human Approval Semantics & Operator Responsibility

The system operates under a Shared Responsibility Model:

### Decision Matrix

- **`BLOCK`:** The transaction is rejected outright due to a policy violation (e.g. blocked domain) or critical risk finding.
- **`REQUIRE_APPROVAL`:** The transaction exceeds predefined caps (e.g. transaction threshold). It is held in state and cannot be processed until a human operator with `operator` permissions actively signs and uploads the transaction envelope.
- **`APPROVE`:** The transaction falls within the configured rules and low-risk ranges.

### Operator Responsibilities

1. **Policy Configuration:** Operators are responsible for establishing realistic daily budgets and risk limits via policy settings.
2. **Key Security:** Operators must safeguard their wallet credentials and Freighter browser extensions. A compromised operator wallet allows bypassing of approvals.
3. **Accuracy of Data:** The policy engine relies on parameters supplied during setup. Ensure network environment settings (testnet vs mainnet) are correctly initialized.

---

## 5. Safe Wording for Investor & SCF Materials

When presenting Fortexa to external reviewers, investors, or the Stellar Community Fund (SCF), use the following compliant terminology:

- **DO SAY:**
  - _"Fortexa acts as an automated compliance and policy firewall for agentic AI actions on the Stellar Network."_
  - _"The system enforces budget bounds and security guardrails before transaction signing."_
  - _"Audit integrity is guaranteed cryptographically using a tamper-evident SHA-256 hash chain."_
- **DO NOT SAY:**
  - _"Fortexa is a licensed custodian or trust company."_
  - _"Fortexa fully automates regulatory compliance under legal frameworks."_
  - _"The server manages private keys on behalf of users."_

---

## 6. Open Questions for Legal Counsel

Before launching Fortexa commercially, operators and development teams should review the following list with legal counsel:

1. **Custodial vs Non-Custodial Classification:** Confirm that the separation between transaction generation (server) and transaction signing (client wallet) keeps the system classified as non-custodial under target jurisdictions (e.g., US FinCEN guidelines or EU MiCA regulations).
2. **KYC/AML Responsibility:** Clarify if operators using Fortexa to route payments for autonomous agents must implement Know-Your-Customer (KYC) or Anti-Money Laundering (AML) checks, and if Fortexa should provide hooks to verify recipient addresses against public blocklists.
3. **Liability for AI Mistakes:** Define the limitation of liability if an AI agent generates a signed transaction that was correctly approved by configured policy but causes financial loss or violates smart contract terms.
4. **Data Privacy Regulations:** Assess if counterparty wallet addresses and memo fields logged in the database could be classified as Personal Identifiable Information (PII) under GDPR or CCPA, and if specific data retention/erasure rules must apply.
