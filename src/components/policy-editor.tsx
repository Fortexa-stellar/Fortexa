"use client";

import { useCallback, useEffect, useState } from "react";

import { History } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import type { SimulationReport, SimulationSource } from "@/lib/decision/simulate";
import {
  applyValidateResponse,
  buildValidationDisplayErrors,
  canActivateDraft,
  draftIsBlockedByFailedValidation,
  serializePolicyDraft,
  INITIAL_POLICY_VALIDATION_GATE,
  type PolicyFieldErrors,
  type PolicyValidationGate,
} from "@/lib/policy/activation";
import type { DecisionType, PolicyConfig } from "@/lib/types/domain";
import { hasSensitiveField } from "@/lib/settings/save-safety";
import { PolicyImportExport } from "@/components/policy-import-export";
import type { PolicyExport } from "@/lib/policy/import-export";

type PolicyResponse = {
  policy?: PolicyConfig;
  updatedAt?: string | null;
  version?: number;
  error?: string;
  code?: string;
  details?: { fieldErrors?: PolicyFieldErrors };
};

type PolicyConflictResponse = {
  error?: string;
  code?: string;
  expectedVersion?: number;
  currentVersion?: number;
  currentUpdatedAt?: string | null;
};

type PolicyConflictState = {
  expectedVersion: number;
  currentVersion: number;
  currentUpdatedAt: string | null;
  message: string;
};

type PolicyHistoryEntry = {
  version: number;
  updatedAt: string;
  updatedBy?: string;
  policy?: PolicyConfig;
};

type PolicyHistoryResponse = {
  entries?: PolicyHistoryEntry[];
  error?: string;
};

type SimulationResponse = {
  report?: SimulationReport;
  auditSampled?: number;
  error?: string;
};

type RollbackPreviewResponse = {
  report?: SimulationReport;
  targetVersion?: number;
  currentVersion?: number;
  auditSampled?: number;
  error?: string;
};

function listToText(list: string[]) {
  return list.join("\n");
}

function textToList(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function PolicyEditor({
  networkMatches = true,
  networkFingerprint = "",
}: {
  networkMatches?: boolean;
  networkFingerprint?: string;
} = {}) {
  const { isOperator, loading: sessionLoading } = useAuthSession();
  const [policy, setPolicy] = useState<PolicyConfig | null>(null);
  const [allowedDomains, setAllowedDomains] = useState("");
  const [blockedDomains, setBlockedDomains] = useState("");
  const [allowedTools, setAllowedTools] = useState("");
  const [blockedTools, setBlockedTools] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [history, setHistory] = useState<PolicyHistoryEntry[]>([]);
  const [status, setStatus] = useState<string>("Loading policy...");
  const [loading, setLoading] = useState(false);
  const [diffA, setDiffA] = useState<number | null>(null);
  const [diffB, setDiffB] = useState<number | null>(null);
  const [includeAudit, setIncludeAudit] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simulation, setSimulation] = useState<SimulationReport | null>(null);
  const [simStatus, setSimStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PolicyConflictState | null>(null);
  const [rollbackPreviewVersion, setRollbackPreviewVersion] = useState<number | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<SimulationReport | null>(null);
  const [rollbackPreviewStatus, setRollbackPreviewStatus] = useState<string | null>(null);
  const [previewingRollback, setPreviewingRollback] = useState(false);
  const [serverNetworkMatches, setServerNetworkMatches] = useState<boolean | null>(null);
  const [validationGate, setValidationGate] = useState<PolicyValidationGate>(
    INITIAL_POLICY_VALIDATION_GATE,
  );

  function resetActivationGate() {
    setValidationGate(INITIAL_POLICY_VALIDATION_GATE);
  }

  const sensitivePayload = hasSensitiveField(policy);
  const networkMismatch = !networkMatches || serverNetworkMatches === false;
  const writeDisabled = loading || sessionLoading || !isOperator;
  const saveDisabled = writeDisabled || serverNetworkMatches !== true || networkMismatch || sensitivePayload;

  /** Assemble the unsaved draft policy from the current editor state. */
  function buildDraftPolicy(base: PolicyConfig): PolicyConfig {
    return {
      ...base,
      allowedDomains: textToList(allowedDomains),
      blockedDomains: textToList(blockedDomains),
      allowedTools: textToList(allowedTools),
      blockedTools: textToList(blockedTools),
    };
  }

  /** Serialized current draft — binds any validation result to the exact document it checked. */
  const currentDraftKey = policy ? serializePolicyDraft(buildDraftPolicy(policy)) : null;
  /** Activate must stay disabled while validation failed for this exact draft. */
  const activateBlocked = draftIsBlockedByFailedValidation(validationGate, currentDraftKey);
  /** Activation is only possible after the validate route accepted this exact draft. */
  const activateUnlocked = canActivateDraft(validationGate, currentDraftKey);

  const loadPolicy = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/policy", { cache: "no-store" });
      const payload = (await response.json()) as PolicyResponse;

      if (!response.ok || payload.error || !payload.policy) {
        setStatus(payload.error ?? "Failed to load policy.");
        return;
      }

      setPolicy(payload.policy);
      setAllowedDomains(listToText(payload.policy.allowedDomains));
      setBlockedDomains(listToText(payload.policy.blockedDomains));
      setAllowedTools(listToText(payload.policy.allowedTools));
      setBlockedTools(listToText(payload.policy.blockedTools));
      setUpdatedAt(payload.updatedAt ?? null);
      setVersion(payload.version ?? null);
      setConflict(null);
      setValidationGate(INITIAL_POLICY_VALIDATION_GATE);
      setStatus("Policy loaded.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected policy load error.");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Pull the latest server version and replace the editor draft with it.
   * Used to recover from a 409 Conflict: the operator's local edits are
   * intentionally discarded so they can re-enter them against the new base.
   * Asks for an explicit confirmation so a misclick can't wipe out work.
   */
  async function discardLocalChangesAndReload() {
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      const acknowledged = window.confirm(
        "Discard your unsaved policy edits and reload the current server version?",
      );
      if (!acknowledged) {
        return;
      }
    }

    setLoading(true);
    try {
      const response = await fetch("/api/policy", { cache: "no-store" });
      const payload = (await response.json()) as PolicyResponse;

      if (!response.ok || payload.error || !payload.policy) {
        setStatus(payload.error ?? "Reload failed — please try again.");
        return;
      }

      setPolicy(payload.policy);
      setAllowedDomains(listToText(payload.policy.allowedDomains));
      setBlockedDomains(listToText(payload.policy.blockedDomains));
      setAllowedTools(listToText(payload.policy.allowedTools));
      setBlockedTools(listToText(payload.policy.blockedTools));
      setUpdatedAt(payload.updatedAt ?? null);
      setVersion(payload.version ?? null);
      setConflict(null);
      setValidationGate(INITIAL_POLICY_VALIDATION_GATE);
      setStatus("Reloaded latest policy from server. Local edits discarded — please re-enter your changes.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected reload error.");
    } finally {
      setLoading(false);
    }
  }

  async function savePolicy() {
    if (networkMismatch || serverNetworkMatches !== true || hasSensitiveField(policy)) {
      setStatus("Saving is disabled because the network differs or the policy contains a sensitive field.");
      return;
    }
    if (!isOperator) {
      setStatus("Viewer role is read-only. Login as operator to update policy.");
      return;
    }

    if (!policy) {
      setStatus("Policy is not loaded yet.");
      return;
    }

    const nextPolicy = buildDraftPolicy(policy);
    await postPolicyUpdate(nextPolicy, "Policy saved successfully.");
  }

  /**
   * POST the given document to /api/policy and apply the response.
   * Shared by the gated activation flow and the import flow.
   */
  async function postPolicyUpdate(nextPolicy: PolicyConfig, successStatus: string): Promise<boolean> {
    setLoading(true);
    setConflict(null);
    try {
      // Send the version we loaded against so the server can detect another
      // operator's concurrent save. Missing it keeps the legacy behavior.
      const body = JSON.stringify({
        ...nextPolicy,
        ...(version !== null ? { expectedVersion: version } : {}),
      });

      const response = await fetch("/api/policy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fortexa-Network-Fingerprint": networkFingerprint,
        },
        body,
      });

      if (response.status === 409) {
        const conflictBody = (await response.json().catch(() => ({}))) as PolicyConflictResponse;
        if (conflictBody.code === "NETWORK_MISMATCH") {
          setServerNetworkMatches(false);
          setStatus(conflictBody.error ?? "Server network changed. Saving is disabled.");
          return false;
        }
        const expectedVersion =
          conflictBody.expectedVersion ?? version ?? -1;
        const currentVersion = conflictBody.currentVersion ?? -1;
        setConflict({
          expectedVersion,
          currentVersion,
          currentUpdatedAt: conflictBody.currentUpdatedAt ?? null,
          message:
            conflictBody.error ??
            "Policy was changed by another operator. Please reload and retry.",
        });
        setStatus(
          `Conflict: server is at v${conflictBody.currentVersion ?? "?"}, your edit was based on v${
            conflictBody.expectedVersion ?? version ?? "?"
          }.`,
        );
        // Refresh history view in case the other operator's save landed.
        void loadHistory();
        return false;
      }

      const payload = (await response.json()) as PolicyResponse;

      if (!response.ok || payload.error || !payload.policy) {
        // Surface the API's field errors verbatim when it rejects the document.
        if (payload.details?.fieldErrors) {
          setValidationGate({
            status: "invalid",
            draftKey: null,
            errors: [],
            fieldErrors: payload.details.fieldErrors,
          });
        }
        setStatus(payload.error ?? "Failed to save policy.");
        return false;
      }

      setPolicy(payload.policy);
      setAllowedDomains(listToText(payload.policy.allowedDomains));
      setBlockedDomains(listToText(payload.policy.blockedDomains));
      setAllowedTools(listToText(payload.policy.allowedTools));
      setBlockedTools(listToText(payload.policy.blockedTools));
      setUpdatedAt(payload.updatedAt ?? null);
      setVersion(payload.version ?? null);
      setStatus(successStatus);
      resetActivationGate();
      await loadHistory();
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected policy save error.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  /**
   * Submit the unsaved draft to the validate route. The result is bound to
   * the serialized draft, so editing any field re-requires validation.
   * API errors are stored exactly as returned — never rewritten.
   */
  async function validateDraft(): Promise<boolean> {
    if (!policy) {
      setStatus("Policy is not loaded yet.");
      return false;
    }

    const draftKey = serializePolicyDraft(buildDraftPolicy(policy));
    setValidationGate({ ...INITIAL_POLICY_VALIDATION_GATE, status: "validating", draftKey });
    try {
      const response = await fetch("/api/policy/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: buildDraftPolicy(policy) }),
      });
      const payload = (await response.json().catch(() => ({}))) as unknown;
      const gate = applyValidateResponse(draftKey, response.ok, payload);
      setValidationGate(gate);
      return gate.status === "valid";
    } catch (error) {
      const gate = applyValidateResponse(draftKey, false, {
        errors: [error instanceof Error ? error.message : "Unexpected validation error."],
      });
      setValidationGate(gate);
      return false;
    }
  }

  /**
   * Activation is hard-gated: the draft is submitted to the validate route
   * first, and only an accepted document is POSTed to /api/policy.
   */
  async function handleActivate() {
    if (!isOperator) {
      setStatus("Viewer role is read-only. Login as operator to activate policy.");
      return;
    }

    if (!policy) {
      setStatus("Policy is not loaded yet.");
      return;
    }

    const validated = await validateDraft();
    if (!validated) {
      setStatus("Activation blocked: the validate route rejected this draft. Fix the listed errors and validate again.");
      return;
    }

    await postPolicyUpdate(buildDraftPolicy(policy), "Policy activated successfully.");
  }

  async function runSimulation() {
    if (!isOperator) {
      setSimStatus("Viewer role is read-only. Login as operator to simulate policy changes.");
      return;
    }

    if (!policy) {
      setSimStatus("Policy is not loaded yet.");
      return;
    }

    setSimulating(true);
    setSimStatus(null);
    try {
      const draftPolicy = buildDraftPolicy(policy);

      const response = await fetch("/api/policy/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy: draftPolicy, includeAudit }),
      });

      const payload = (await response.json()) as SimulationResponse;

      if (!response.ok || payload.error || !payload.report) {
        setSimulation(null);
        setSimStatus(payload.error ?? "Simulation failed. Check the policy values and try again.");
        return;
      }

      setSimulation(payload.report);

      const { changed, total } = payload.report.summary;
      const auditNote =
        includeAudit && (payload.auditSampled ?? 0) === 0
          ? " No recent audit actions were available to sample."
          : includeAudit
            ? ` Included ${payload.auditSampled} recent audit action(s).`
            : "";
      setSimStatus(
        `Simulated ${total} case(s): ${changed} decision(s) would change. Nothing was saved.${auditNote}`,
      );
    } catch (error) {
      setSimulation(null);
      setSimStatus(error instanceof Error ? error.message : "Unexpected simulation error.");
    } finally {
      setSimulating(false);
    }
  }

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/policy/history?limit=8", { cache: "no-store" });
      const payload = (await response.json()) as PolicyHistoryResponse;

      if (!response.ok || payload.error) {
        return;
      }

      setHistory(payload.entries ?? []);
    } catch {
      setHistory([]);
    }
  }, []);

  async function previewRollback(versionToPreview: number) {
    if (!isOperator) {
      setStatus("Viewer role is read-only. Login as operator to preview rollback.");
      return;
    }

    setPreviewingRollback(true);
    setRollbackPreviewStatus(null);
    setRollbackPreview(null);
    setRollbackPreviewVersion(versionToPreview);

    try {
      const response = await fetch("/api/policy/rollback/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetVersion: versionToPreview, includeAudit }),
      });

      const payload = (await response.json()) as RollbackPreviewResponse;

      if (!response.ok || payload.error || !payload.report) {
        setRollbackPreviewVersion(null);
        setRollbackPreviewStatus(payload.error ?? "Rollback preview failed.");
        return;
      }

      setRollbackPreview(payload.report);
      const { changed, total } = payload.report.summary;
      const auditNote =
        includeAudit && (payload.auditSampled ?? 0) === 0
          ? " No recent audit actions were available to sample."
          : includeAudit
            ? ` Included ${payload.auditSampled} recent audit action(s).`
            : "";
      setRollbackPreviewStatus(
        `Preview for v${versionToPreview}: ${changed} of ${total} decision(s) would change. Nothing was saved.${auditNote}`,
      );
    } catch (error) {
      setRollbackPreviewVersion(null);
      setRollbackPreviewStatus(error instanceof Error ? error.message : "Unexpected rollback preview error.");
    } finally {
      setPreviewingRollback(false);
    }
  }

  async function confirmRollback(versionToRollback: number) {
    if (saveDisabled) {
      setStatus("Saving is disabled until the server network matches this page.");
      return;
    }
    if (!isOperator) {
      setStatus("Viewer role is read-only. Login as operator to rollback policy.");
      return;
    }

    const confirmed = window.confirm(
      `Restore policy version ${versionToRollback}? This creates a new policy version with the historical rules.`,
    );
    if (!confirmed) {
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/policy/rollback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fortexa-Network-Fingerprint": networkFingerprint,
        },
        body: JSON.stringify({ targetVersion: versionToRollback }),
      });

      const payload = (await response.json()) as PolicyResponse;
      if (payload.code === "NETWORK_MISMATCH") setServerNetworkMatches(false);

      if (!response.ok || payload.error || !payload.policy) {
        setStatus(payload.error ?? "Rollback failed.");
        return;
      }

      setPolicy(payload.policy);
      setAllowedDomains(listToText(payload.policy.allowedDomains));
      setBlockedDomains(listToText(payload.policy.blockedDomains));
      setAllowedTools(listToText(payload.policy.allowedTools));
      setBlockedTools(listToText(payload.policy.blockedTools));
      setUpdatedAt(payload.updatedAt ?? null);
      setVersion(payload.version ?? null);
      setRollbackPreview(null);
      setRollbackPreviewVersion(null);
      setRollbackPreviewStatus(null);
      resetActivationGate();
      setStatus(`Rollback successful to version ${versionToRollback}.`);
      await loadHistory();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected rollback error.");
    } finally {
      setLoading(false);
    }
  }

  async function handleImportPolicy(document: PolicyExport) {
    if (!isOperator) {
      throw new Error("Viewer role is read-only. Login as operator to import policy.");
    }

    setLoading(true);
    try {
      const response = await fetch("/api/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(document),
      });

      const payload = (await response.json()) as PolicyResponse;

      if (payload.code === "NETWORK_MISMATCH") setServerNetworkMatches(false);

      if (!response.ok || payload.error || !payload.policy) {
        throw new Error(payload.error ?? "Failed to save imported policy.");
      }

      setPolicy(payload.policy);
      setAllowedDomains(listToText(payload.policy.allowedDomains));
      setBlockedDomains(listToText(payload.policy.blockedDomains));
      setAllowedTools(listToText(payload.policy.allowedTools));
      setBlockedTools(listToText(payload.policy.blockedTools));
      setUpdatedAt(payload.updatedAt ?? null);
      setVersion(payload.version ?? null);
      setStatus("Policy imported successfully.");
      await loadHistory();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unexpected import error.");
      throw error;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/stellar/network-config", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Network check failed");
        return (await response.json()) as { fingerprint?: string; valid?: boolean };
      })
      .then((current) => {
        if (active) setServerNetworkMatches(current.valid === true && current.fingerprint === networkFingerprint);
      })
      .catch(() => {
        if (active) setServerNetworkMatches(false);
      });
    return () => { active = false; };
  }, [networkFingerprint]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
    void loadPolicy();
    void loadHistory();
  }, [loadPolicy, loadHistory]);

  return (
    <div className="space-y-6">
      {networkMismatch || sensitivePayload ? (
        <Alert className="border-red-500/40 bg-red-500/10" role="alert" aria-live="assertive">
          <AlertTitle>Saving disabled</AlertTitle>
          <AlertDescription>
            {networkMismatch
              ? "The displayed network differs from the server configuration."
              : "The policy contains a sensitive field."}
          </AlertDescription>
        </Alert>
      ) : null}
      {!sessionLoading && !isOperator ? (
        <Alert className="border-amber-500/40 bg-amber-500/10" role="status" aria-live="polite">
          <AlertTitle>Viewer mode</AlertTitle>
          <AlertDescription>Policy editing is disabled. Only operator role can update policy.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Policy Engine Rules</CardTitle>
          <CardDescription>Edit active deterministic controls used by the decision engine.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl bg-[hsl(var(--muted)/0.35)] p-3">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Current version</p>
            <p className="text-lg font-semibold">{version ?? "-"}</p>
          </div>
          <div className="rounded-xl bg-[hsl(var(--muted)/0.35)] p-3">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Per-transaction cap</p>
            <Input
              type="number"
              aria-label="Per-transaction cap"
              aria-disabled={writeDisabled}
              value={policy?.perTxCapXLM ?? 0}
              disabled={writeDisabled}
              onChange={(event) =>
                setPolicy((prev) => (prev ? { ...prev, perTxCapXLM: Number(event.target.value) || 0 } : prev))
              }
            />
          </div>
          <div className="rounded-xl bg-[hsl(var(--muted)/0.35)] p-3">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Daily spending cap</p>
            <Input
              type="number"
              aria-label="Daily spending cap"
              aria-disabled={writeDisabled}
              value={policy?.dailyCapXLM ?? 0}
              disabled={writeDisabled}
              onChange={(event) =>
                setPolicy((prev) => (prev ? { ...prev, dailyCapXLM: Number(event.target.value) || 0 } : prev))
              }
            />
          </div>
          <div className="rounded-xl bg-[hsl(var(--muted)/0.35)] p-3">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Max tool calls/day</p>
            <Input
              type="number"
              aria-label="Max tool calls per day"
              aria-disabled={writeDisabled}
              value={policy?.maxToolCallsPerDay ?? 0}
              disabled={writeDisabled}
              onChange={(event) =>
                setPolicy((prev) => (prev ? { ...prev, maxToolCallsPerDay: Number(event.target.value) || 0 } : prev))
              }
            />
          </div>
          <div className="rounded-xl bg-[hsl(var(--muted)/0.35)] p-3">
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Risk score threshold</p>
            <Input
              type="number"
              aria-label="Risk score threshold"
              aria-disabled={writeDisabled}
              value={policy?.riskThreshold ?? 0}
              disabled={writeDisabled}
              onChange={(event) =>
                setPolicy((prev) => (prev ? { ...prev, riskThreshold: Number(event.target.value) || 0 } : prev))
              }
            />
          </div>
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Allowed domains</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              aria-label="Allowed domains"
              aria-disabled={writeDisabled}
              className="min-h-32 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring)/0.4)]"
              value={allowedDomains}
              disabled={writeDisabled}
              onChange={(event) => setAllowedDomains(event.target.value)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Blocked domains</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              aria-label="Blocked domains"
              aria-disabled={writeDisabled}
              className="min-h-32 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring)/0.4)]"
              value={blockedDomains}
              disabled={writeDisabled}
              onChange={(event) => setBlockedDomains(event.target.value)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Allowed tools</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              aria-label="Allowed tools"
              aria-disabled={writeDisabled}
              className="min-h-32 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring)/0.4)]"
              value={allowedTools}
              disabled={writeDisabled}
              onChange={(event) => setAllowedTools(event.target.value)}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Blocked tools</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              aria-label="Blocked tools"
              aria-disabled={writeDisabled}
              className="min-h-32 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring)/0.4)]"
              value={blockedTools}
              disabled={writeDisabled}
              onChange={(event) => setBlockedTools(event.target.value)}
            />
          </CardContent>
        </Card>
      </section>

        <PolicyImportExport
          currentPolicy={policy}
          currentVersion={version}
          onImportApproved={handleImportPolicy}
          isOperator={isOperator}
          isLoading={saveDisabled}
        />

      <Card>
        <CardHeader>
          <CardTitle>Policy Version History</CardTitle>
          <CardDescription>
            Preview rollback impact before restoring a prior version. Confirmation is required before applying.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {history.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.15)] px-6 py-10 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[hsl(var(--muted)/0.4)]">
                <History className="h-5 w-5 text-[hsl(var(--muted-foreground))]" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-[hsl(var(--foreground))]">No version history yet</p>
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  Saved policy changes will appear here. After your first policy update, each version will be listed for comparison and rollback.
                </p>
              </div>
            </div>
          ) : null}
          {history.map((entry) => {
            const isA = diffA === entry.version;
            const isB = diffB === entry.version;
            return (
              <div key={entry.version} className="flex items-center justify-between rounded-lg border border-[hsl(var(--border))] p-2 text-sm">
                <div>
                  <p className="font-medium flex items-center gap-2">
                    <span>v{entry.version}</span>
                    {version === entry.version && (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-semibold text-emerald-400">
                        Active
                      </span>
                    )}
                  </p>
                  <p className="text-[hsl(var(--muted-foreground))]">
                    {entry.updatedAt}
                    {entry.updatedBy ? ` • ${entry.updatedBy}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={isA ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDiffA(isA ? null : entry.version)}
                    aria-label={isA ? `Deselect version ${entry.version} as diff baseline (A)` : `Select version ${entry.version} as diff baseline (A)`}
                    aria-pressed={isA}
                  >
                    A
                  </Button>
                  <Button
                    variant={isB ? "default" : "outline"}
                    size="sm"
                    onClick={() => setDiffB(isB ? null : entry.version)}
                    aria-label={isB ? `Deselect version ${entry.version} as diff comparison (B)` : `Select version ${entry.version} as diff comparison (B)`}
                    aria-pressed={isB}
                  >
                    B
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => previewRollback(entry.version)}
                  >
                    Preview
                  </Button>
                </div>
              </div>
            );
          })}

          {history.length > 0 && !history.some((entry) => entry.version !== version) ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))] mt-2">
              Rollback is unavailable because no prior policy versions exist.
            </p>
          ) : null}


          {diffA !== null && diffB !== null && diffA !== diffB ? (
            <PolicyDiff
              entryA={history.find((e) => e.version === diffA)!}
              entryB={history.find((e) => e.version === diffB)!}
            />
          ) : diffA !== null && diffB !== null && diffA === diffB ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))] pt-2">Select two different versions to compare.</p>
          ) : diffA !== null || diffB !== null ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))] pt-2">
              Select one more version ({diffA !== null ? "B" : "A"}) to compare.
            </p>
          ) : null}

          {rollbackPreviewStatus ? (
            <Alert className="border-[hsl(var(--accent)/0.2)] bg-[hsl(var(--accent)/0.05)]">
              <AlertTitle>Rollback preview</AlertTitle>
              <AlertDescription>{rollbackPreviewStatus}</AlertDescription>
            </Alert>
          ) : null}

          {previewingRollback ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Evaluating rollback impact...</p>
          ) : rollbackPreview && rollbackPreviewVersion !== null ? (
            <div className="space-y-3">
              <SimulationPanel
                report={rollbackPreview}
                labels={{ from: "Current", to: `Rollback v${rollbackPreviewVersion}` }}
              />
              <Button
                variant="danger"
                size="sm"
                disabled={saveDisabled}
                onClick={() => confirmRollback(rollbackPreviewVersion)}
              >
                Confirm rollback to v{rollbackPreviewVersion}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Simulate before saving</CardTitle>
          <CardDescription>
            Dry-run the unsaved draft against demo scenarios (and optionally your recent audit actions) to compare
            current vs proposed decisions. This is a pre-save safety check — it never saves the policy or consumes usage.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={runSimulation} disabled={writeDisabled || simulating} aria-disabled={writeDisabled || simulating} aria-label="Run simulation">
              {simulating ? "Simulating..." : "Run simulation"}
            </Button>
            <label className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
              <input
                type="checkbox"
                checked={includeAudit}
                disabled={writeDisabled || simulating}
                onChange={(event) => setIncludeAudit(event.target.checked)}
              />
              Include recent audit sample
            </label>
          </div>

          {simStatus ? (
            <Alert className="border-[hsl(var(--accent)/0.2)] bg-[hsl(var(--accent)/0.05)]">
              <AlertTitle>Simulation status</AlertTitle>
              <AlertDescription>{simStatus}</AlertDescription>
            </Alert>
          ) : null}

          {simulating ? (
            <p className="text-sm text-[hsl(var(--muted-foreground))]">Evaluating draft policy...</p>
          ) : simulation ? (
            <SimulationPanel report={simulation} />
          ) : null}
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button onClick={savePolicy} disabled={saveDisabled} aria-disabled={saveDisabled} aria-label="Save Policy">Save Policy</Button>
        <Button variant="outline" onClick={loadPolicy} disabled={loading} aria-disabled={loading} aria-label="Reload policy">Reload</Button>
        <Button variant="outline" onClick={loadHistory} disabled={loading} aria-disabled={loading} aria-label="Reload policy history">Reload History</Button>
      </div>

      {validationGate.status === "valid" ? (
        <Alert className="border-emerald-500/40 bg-emerald-500/10" data-testid="policy-validation-status" role="status" aria-live="polite">
          <AlertTitle>Draft validated</AlertTitle>
          <AlertDescription>
            The validate route accepted this exact document. Activation is unlocked until you edit the draft.
          </AlertDescription>
        </Alert>
      ) : validationGate.status === "invalid" ? (
        <Alert className="border-red-500/40 bg-red-500/10" data-testid="policy-validation-status" role="alert" aria-live="assertive">
          <AlertTitle>Validation failed — activation is disabled</AlertTitle>
          <AlertDescription>
            <p>
              The validate route rejected this draft. The errors below are returned by the API and shown
              unmodified.
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-4" aria-label="Validation error list">
              {buildValidationDisplayErrors(validationGate).map((error) => (
                <li key={error} className="break-words font-mono text-xs">
                  {error}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {conflict ? (
        <Alert className="border-red-500/40 bg-red-500/10" role="alert" aria-live="assertive">
          <AlertTitle>Save conflict — another operator edited this policy</AlertTitle>
          <AlertDescription>
            <p>{conflict.message}</p>
            <p className="mt-1 text-sm">
              Your save was based on{" "}
              <span className="font-semibold">v{conflict.expectedVersion}</span>; the server is now at{" "}
              <span className="font-semibold">v{conflict.currentVersion}</span>
              {conflict.currentUpdatedAt
                ? ` (updated ${conflict.currentUpdatedAt})`
                : ""}
              . Your changes were not discarded automatically.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={discardLocalChangesAndReload}
                disabled={loading}
              >
                Reload latest &amp; discard my changes
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConflict(null)}
                disabled={loading}
              >
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <Alert className="border-[hsl(var(--accent)/0.2)] bg-[hsl(var(--accent)/0.05)]" role="status" aria-live="polite">
        <AlertTitle>Policy status</AlertTitle>
        <AlertDescription>
          {status}
          {updatedAt ? ` Last updated: ${updatedAt}` : ""}
        </AlertDescription>
      </Alert>
    </div>
  );
}

// ── PolicyDiff ────────────────────────────────────────────────────────────────

type DiffStatus = "added" | "removed" | "unchanged";

export function diffLists(a: string[], b: string[]): Array<{ value: string; status: DiffStatus }> {
  const setA = new Set(a);
  const setB = new Set(b);
  const all = Array.from(new Set([...a, ...b]));
  return all.map((value) => {
    if (setA.has(value) && !setB.has(value)) return { value, status: "removed" };
    if (!setA.has(value) && setB.has(value)) return { value, status: "added" };
    return { value, status: "unchanged" };
  });
}

const STATUS_STYLE: Record<DiffStatus, string> = {
  added: "bg-emerald-500/15 text-emerald-400",
  removed: "bg-red-500/15 text-red-400 line-through",
  unchanged: "text-[hsl(var(--muted-foreground))]",
};

const STATUS_PREFIX: Record<DiffStatus, string> = { added: "+ ", removed: "− ", unchanged: "  " };

function NumericDiffRow({ label, a, b }: { label: string; a: number | undefined; b: number | undefined }) {
  const changed = a !== b;
  return (
    <div className={`flex items-center justify-between rounded px-2 py-1 text-sm ${changed ? "bg-amber-500/15" : ""}`}>
      <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
      <span>
        {changed ? (
          <>
            <span className="text-red-400 line-through mr-2">{a ?? "—"}</span>
            <span className="text-emerald-400">{b ?? "—"}</span>
          </>
        ) : (
          <span className="text-[hsl(var(--muted-foreground))]">{a ?? "—"}</span>
        )}
      </span>
    </div>
  );
}

function ListDiffSection({ label, a, b }: { label: string; a: string[]; b: string[] }) {
  const items = diffLists(a, b);
  const hasChanges = items.some((i) => i.status !== "unchanged");
  return (
    <div>
      <p className={`text-xs font-semibold mb-1 ${hasChanges ? "text-amber-400" : "text-[hsl(var(--muted-foreground))]"}`}>
        {label}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-[hsl(var(--muted-foreground))] italic">empty</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.value} className={`rounded px-2 py-0.5 text-xs font-mono ${STATUS_STYLE[item.status]}`}>
              {STATUS_PREFIX[item.status]}{item.value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── SimulationPanel ─────────────────────────────────────────────────────────

const DECISION_STYLE: Record<DecisionType, string> = {
  APPROVE: "bg-emerald-500/15 text-emerald-400",
  WARN: "bg-amber-500/15 text-amber-400",
  REQUIRE_APPROVAL: "bg-sky-500/15 text-sky-400",
  BLOCK: "bg-red-500/15 text-red-400",
};

const SOURCE_LABEL: Record<SimulationSource, string> = {
  scenario: "Demo scenario",
  audit: "Recent audit",
};

function DecisionTag({ decision }: { decision: DecisionType }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-mono ${DECISION_STYLE[decision]}`}>{decision}</span>
  );
}

function SimulationPanel({
  report,
  labels = { from: "Current", to: "Proposed" },
}: {
  report: SimulationReport;
  labels?: { from: string; to: string };
}) {
  if (report.cases.length === 0) {
    return (
      <p className="text-sm text-[hsl(var(--muted-foreground))]">
        No cases were available to simulate.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-lg bg-[hsl(var(--muted)/0.35)] px-3 py-1">
          Cases: <span className="font-semibold">{report.summary.total}</span>
        </span>
        <span className="rounded-lg bg-amber-500/15 px-3 py-1 text-amber-400">
          Changed: <span className="font-semibold">{report.summary.changed}</span>
        </span>
      </div>

      <ul className="space-y-2">
        {report.cases.map((entry) => (
          <li
            key={entry.id}
            className={`rounded-lg border p-3 text-sm ${
              entry.changed ? "border-amber-500/40 bg-amber-500/5" : "border-[hsl(var(--border))]"
            }`}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="font-medium">{entry.label}</p>
                <p className="text-xs text-[hsl(var(--muted-foreground))]">{SOURCE_LABEL[entry.source]}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[hsl(var(--muted-foreground))]">{labels.from}</span>
                <DecisionTag decision={entry.current.decision} />
                <span className="text-[hsl(var(--muted-foreground))]">→</span>
                <span className="text-xs text-[hsl(var(--muted-foreground))]">{labels.to}</span>
                <DecisionTag decision={entry.proposed.decision} />
                {entry.changed ? (
                  <span className="text-xs font-semibold text-amber-400">changed</span>
                ) : (
                  <span className="text-xs text-[hsl(var(--muted-foreground))]">same</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PolicyDiff({ entryA, entryB }: { entryA: PolicyHistoryEntry; entryB: PolicyHistoryEntry }) {
  const a = entryA.policy;
  const b = entryB.policy;

  if (!a || !b) {
    return (
      <Alert className="mt-3 border-amber-500/40 bg-amber-500/10">
        <AlertTitle>Diff unavailable</AlertTitle>
        <AlertDescription>Policy data not available for one or both selected versions.</AlertDescription>
      </Alert>
    );
  }

  const hoursChanged = a.allowedHours?.start !== b.allowedHours?.start || a.allowedHours?.end !== b.allowedHours?.end;

  return (
    <div className="mt-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.2)] p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-semibold">
          Diff: <span className="text-red-400">v{entryA.version}</span>
          {" → "}
          <span className="text-emerald-400">v{entryB.version}</span>
        </p>
        <div className="flex gap-3 text-xs text-[hsl(var(--muted-foreground))]">
          <span className="text-red-400">− removed</span>
          <span className="text-emerald-400">+ added</span>
          <span className="text-amber-400">~ changed</span>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-semibold text-[hsl(var(--muted-foreground))] mb-1">Caps &amp; Thresholds</p>
        <NumericDiffRow label="Per-tx cap (XLM)" a={a.perTxCapXLM} b={b.perTxCapXLM} />
        <NumericDiffRow label="Daily cap (XLM)" a={a.dailyCapXLM} b={b.dailyCapXLM} />
        <NumericDiffRow label="Max tool calls/day" a={a.maxToolCallsPerDay} b={b.maxToolCallsPerDay} />
        <NumericDiffRow label="Risk threshold" a={a.riskThreshold} b={b.riskThreshold} />
        {(a.allowedHours ?? b.allowedHours) ? (
          <div className={`flex items-center justify-between rounded px-2 py-1 text-sm ${hoursChanged ? "bg-amber-500/15" : ""}`}>
            <span className="text-[hsl(var(--muted-foreground))]">Allowed hours</span>
            <span>
              {hoursChanged ? (
                <>
                  <span className="text-red-400 line-through mr-2">
                    {a.allowedHours ? `${a.allowedHours.start}–${a.allowedHours.end}` : "—"}
                  </span>
                  <span className="text-emerald-400">
                    {b.allowedHours ? `${b.allowedHours.start}–${b.allowedHours.end}` : "—"}
                  </span>
                </>
              ) : (
                <span className="text-[hsl(var(--muted-foreground))]">
                  {a.allowedHours ? `${a.allowedHours.start}–${a.allowedHours.end}` : "—"}
                </span>
              )}
            </span>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ListDiffSection label="Allowed domains" a={a.allowedDomains} b={b.allowedDomains} />
        <ListDiffSection label="Blocked domains" a={a.blockedDomains} b={b.blockedDomains} />
        <ListDiffSection label="Allowed tools" a={a.allowedTools} b={b.allowedTools} />
        <ListDiffSection label="Blocked tools" a={a.blockedTools} b={b.blockedTools} />
      </div>
    </div>
  );
}
