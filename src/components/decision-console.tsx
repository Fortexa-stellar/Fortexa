"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  Sparkles,
  ChevronRight,
  ChevronLeft,
  ShieldAlert,
  Play,
  Hand,
  RefreshCcw,
} from "lucide-react";

import { DecisionBadge } from "@/components/decision-badge";
import { DecisionResultView, type EngineDecisionResult } from "@/components/decision-result-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { signFreighterXdr, type FreighterSignErrorCode } from "@/lib/auth/freighter";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { demoScenarios } from "@/lib/scenarios/seed";
import type { AgentAction } from "@/lib/types/domain";
import { cn } from "@/lib/utils/cn";
import { truncateMiddle } from "@/lib/utils/format";

const SIGN_ERROR_HINTS: Record<FreighterSignErrorCode, string> = {
  missing: "Install Freighter from freighter.app, refresh, then retry signing.",
  rejected: "Open Freighter and approve the transaction, then retry signing.",
  passphrase_mismatch: "Switch Freighter to Stellar Testnet, then retry signing.",
  invalid_key: "Unlock the matching account in Freighter, then retry signing.",
  unknown: "Retry signing, or prepare the XDR again if the problem persists.",
};

const SIGN_ERROR_TITLES: Record<FreighterSignErrorCode, string> = {
  missing: "Freighter not detected",
  rejected: "Signing was rejected",
  passphrase_mismatch: "Wrong network in Freighter",
  invalid_key: "Wrong signing key",
  unknown: "Signing failed",
};

type DecisionApiResponse = {
  result: EngineDecisionResult;
  auditEntry: {
    id: string;
    paymentQuote?: {
      destination: string;
      amountXLM: string;
      asset: string;
      memo: string;
      network: string;
    };
  };
  usage: { spentXLM: number; toolCalls: number };
};

type BalanceApiResponse = {
  configured: boolean;
  source?: "external";
  publicKey?: string;
  network?: string;
  error?: string;
};

type BuildPaymentResponse = {
  ok?: boolean;
  error?: string;
  details?: { fieldErrors?: Record<string, string[] | undefined> };
  xdr?: string;
  sourcePublicKey?: string;
  networkPassphrase?: string;
  decisionId?: string;
  quoteExpiresAt?: string;
  buildAuthorization?: string;
};

type AgentPlanResponse = { ok?: boolean; error?: string; action?: AgentAction };

type ToastItem = { id: string; kind: "success" | "error"; text: string };

const WIZARD_STEPS = [
  { id: 1, label: "Intent" },
  { id: 2, label: "Evaluate" },
  { id: 3, label: "Approve" },
  { id: 4, label: "Execute" },
];

export function DecisionConsole() {
  const { isOperator, loading: sessionLoading } = useAuthSession();
  const [step, setStep] = useState(1);
  const [intentMode, setIntentMode] = useState<"scenario" | "ai">("scenario");
  const [selectedScenarioId, setSelectedScenarioId] = useState(demoScenarios[0]?.id ?? "");
  const [destination, setDestination] = useState(process.env.NEXT_PUBLIC_STELLAR_DESTINATION ?? "");
  const [executeAmount, setExecuteAmount] = useState("");
  const [decisionData, setDecisionData] = useState<DecisionApiResponse | null>(null);
  const [authorizedAuditEntryId, setAuthorizedAuditEntryId] = useState<string | null>(null);
  const [paymentBuildAuthorization, setPaymentBuildAuthorization] = useState<string | null>(null);
  const [paymentQuoteExpiresAt, setPaymentQuoteExpiresAt] = useState<string | null>(null);
  const [lastTxExplorerUrl, setLastTxExplorerUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [unsignedXdr, setUnsignedXdr] = useState("");
  const [signedXdrInput, setSignedXdrInput] = useState("");
  const [sourcePublicKey, setSourcePublicKey] = useState("");
  const [networkPassphrase, setNetworkPassphrase] = useState("TESTNET");
  const [agentGoal, setAgentGoal] = useState(
    "Find safe market data provider and pay for premium query results."
  );
  const [agentContext, setAgentContext] = useState(
    "Need reliable source with low risk and clear policy-compliant endpoint."
  );
  const [generatedAction, setGeneratedAction] = useState<AgentAction | null>(null);
  const [generatingAction, setGeneratingAction] = useState(false);
  const [preparingXdr, setPreparingXdr] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [signError, setSignError] = useState<{
    code: FreighterSignErrorCode;
    message: string;
  } | null>(null);

  const [submitErrorDetails, setSubmitErrorDetails] = useState<{
    explanation?: string;
    nextStep?: string;
    resultCode?: string;
    operationCodes?: string[];
  } | null>(null);

  const selectedScenario = useMemo(
    () => demoScenarios.find((s) => s.id === selectedScenarioId),
    [selectedScenarioId]
  );

  const writeDisabled = loading || preparingXdr || sessionLoading || !isOperator;
  const canHumanApprove = decisionData?.result.decision === "REQUIRE_APPROVAL";

  const activeAction = generatedAction ?? selectedScenario?.action;
  const evaluatedAmount = activeAction?.amountXLM;
  const parsedExecuteAmount = Number(executeAmount);
  const sendAmount =
    Number.isFinite(parsedExecuteAmount) && parsedExecuteAmount > 0
      ? parsedExecuteAmount
      : evaluatedAmount;
  const destinationPreview = destination.trim().toUpperCase();

  useEffect(() => {
    if (step === 4 && evaluatedAmount != null && !executeAmount) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- seeds the prefill of a user-editable amount field
      setExecuteAmount(String(evaluatedAmount));
    }
  }, [step, evaluatedAmount, executeAmount]);

  function resetPreparedXdr() {
    setPaymentBuildAuthorization(null);
    setPaymentQuoteExpiresAt(null);
    setUnsignedXdr("");
    setSignedXdrInput("");
    setSourcePublicKey("");
    setSignError(null);
    setSubmitErrorDetails(null);
  }

  function getExplorerUrl(hash: string) {
    return `https://stellar.expert/explorer/testnet/tx/${hash}`;
  }

  function pushToast(kind: ToastItem["kind"], text: string) {
    const id = crypto.randomUUID();
    setToasts((c) => [...c, { id, kind, text }]);
    setTimeout(() => setToasts((c) => c.filter((t) => t.id !== id)), 4500);
  }

  function ensureOperator() {
    if (isOperator) return true;
    setMessage("Viewer role is read-only. Login as operator to execute.");
    return false;
  }

  async function runDecision(approvedByHuman = false, actionOverride?: AgentAction) {
    if (!ensureOperator()) return;
    if (!selectedScenario && !actionOverride && !generatedAction) return;

    if (approvedByHuman && !canHumanApprove) {
      setMessage("Human approval applies only after REQUIRE_APPROVAL decision.");
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const requestBody = actionOverride
        ? {
            action: actionOverride,
            approvedByHuman,
            ...(destinationPreview
              ? {
                  paymentQuoteInput: {
                    destination: destinationPreview,
                    memo:
                      (actionOverride ?? activeAction)
                        ? `fortexa:${(actionOverride ?? activeAction)!.id}`.slice(0, 28)
                        : undefined,
                    network: "testnet" as const,
                  },
                }
              : {}),
          }
        : generatedAction && intentMode === "ai"
          ? {
              action: generatedAction,
              approvedByHuman,
              ...(destinationPreview
                ? {
                    paymentQuoteInput: {
                      destination: destinationPreview,
                      memo: `fortexa:${generatedAction.id}`.slice(0, 28),
                      network: "testnet" as const,
                    },
                  }
                : {}),
            }
          : {
              scenarioId: selectedScenario?.id,
              approvedByHuman,
              ...(destinationPreview && activeAction
                ? {
                    paymentQuoteInput: {
                      destination: destinationPreview,
                      memo: `fortexa:${activeAction.id}`.slice(0, 28),
                      network: "testnet" as const,
                    },
                  }
                : {}),
            };

      const response = await fetch("/api/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const payload = (await response.json()) as DecisionApiResponse | { error: string };
      if (!response.ok || "error" in payload) {
        const err = "error" in payload ? payload.error : "Decision evaluation failed.";
        setMessage(err);
        pushToast("error", err);
        return;
      }

      resetPreparedXdr();
      setDecisionData(payload);
      setAuthorizedAuditEntryId(payload.auditEntry.id);
      setMessage("Decision recorded in audit trail.");
      pushToast("success", "Evaluation complete.");
      setStep(
        payload.result.decision === "REQUIRE_APPROVAL"
          ? 3
          : payload.result.decision === "BLOCK"
            ? 2
            : 4
      );
    } catch (error) {
      const err = error instanceof Error ? error.message : "Unexpected failure.";
      setMessage(err);
      pushToast("error", err);
    } finally {
      setLoading(false);
    }
  }

  async function generateActionWithAi() {
    if (!ensureOperator()) return;
    setGeneratingAction(true);
    setMessage(null);

    try {
      const response = await fetch("/api/agent/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal: agentGoal.trim(),
          context: agentContext.trim() || undefined,
          destinationHint: destination || undefined,
        }),
      });

      const payload = (await response.json()) as AgentPlanResponse;
      if (!response.ok || payload.error || !payload.action) {
        const err = payload.error ?? "AI action generation failed.";
        setMessage(err);
        pushToast("error", err);
        return;
      }

      setGeneratedAction(payload.action);
      pushToast("success", "Action generated.");
    } catch (error) {
      const err = error instanceof Error ? error.message : "AI planning failed.";
      setMessage(err);
      pushToast("error", err);
    } finally {
      setGeneratingAction(false);
    }
  }

  async function prepareStellarPaymentXdr() {
    if (!ensureOperator()) return;
    const normalizedDestination = destination.trim().toUpperCase();
    if (!activeAction || !normalizedDestination) {
      setMessage("Provide a valid destination address.");
      return;
    }
    if (!authorizedAuditEntryId) {
      setMessage("Run a policy decision before building payment XDR.");
      return;
    }
    if (!/^G[A-Z2-7]{55}$/u.test(normalizedDestination)) {
      setMessage("Destination must be a valid Stellar public key (G...).");
      return;
    }

    const amount = Number(executeAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setMessage("Enter a valid amount in XLM (e.g. 5).");
      return;
    }

    setPreparingXdr(true);
    setMessage(null);
    resetPreparedXdr();

    try {
      const balanceResponse = await fetch("/api/stellar/balance");
      const balancePayload = (await balanceResponse.json()) as BalanceApiResponse;

      if (!balanceResponse.ok || balancePayload.error) {
        setMessage(balancePayload.error ?? "Unable to load wallet.");
        return;
      }

      if (!balancePayload.configured || balancePayload.source !== "external") {
        setMessage("Link a wallet in Settings before executing payments.");
        return;
      }

      const buildResponse = await fetch("/api/stellar/build-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditEntryId: authorizedAuditEntryId,
          destination: normalizedDestination,
          amountXLM: amount.toFixed(7),
          asset: "native",
          memo: `fortexa:${activeAction.id}`.slice(0, 28),
          network: "testnet",
        }),
      });

      const buildPayload = (await buildResponse.json()) as BuildPaymentResponse;
      if (
        !buildResponse.ok ||
        buildPayload.error ||
        !buildPayload.xdr ||
        buildPayload.decisionId !== authorizedAuditEntryId ||
        !buildPayload.quoteExpiresAt ||
        !buildPayload.buildAuthorization
      ) {
        setMessage(buildPayload.error ?? "Failed to build XDR.");
        return;
      }

      setUnsignedXdr(buildPayload.xdr);
      setPaymentBuildAuthorization(buildPayload.buildAuthorization);
      setPaymentQuoteExpiresAt(buildPayload.quoteExpiresAt);
      setSignedXdrInput(buildPayload.xdr);
      setSourcePublicKey(buildPayload.sourcePublicKey ?? balancePayload.publicKey ?? "");
      setNetworkPassphrase(buildPayload.networkPassphrase ?? "TESTNET");
      setMessage(
        `XDR prepared: ${amount} XLM → ${truncateMiddle(normalizedDestination, 8, 8)}. Click Sign & submit.`
      );
      pushToast("success", `${amount} XLM payment ready to sign.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Payment preparation failed.");
    } finally {
      setPreparingXdr(false);
    }
  }

  async function signWithFreighter() {
    if (!ensureOperator() || !unsignedXdr) return;
    setLoading(true);
    setMessage(null);
    setSignError(null);
    setSubmitErrorDetails(null);
    try {
      const result = await signFreighterXdr({
        unsignedXdr,
        expectedNetworkPassphrase: networkPassphrase,
        sourcePublicKey: sourcePublicKey || undefined,
      });

      if (!result.ok) {
        setSignError({ code: result.code, message: result.message });
        pushToast("error", `${SIGN_ERROR_TITLES[result.code]}: ${result.message}`);
        return;
      }

      setSignedXdrInput(result.signedXdr);
      await submitSignedXdr(result.signedXdr);
    } finally {
      setLoading(false);
    }
  }

  async function submitSignedXdr(signedXdrArg?: string) {
    if (!ensureOperator()) return;
    if (!authorizedAuditEntryId || !paymentQuoteExpiresAt || !paymentBuildAuthorization) {
      setMessage("Build a payment from a current decision before submitting.");
      return;
    }
    const signedXdr = (signedXdrArg ?? signedXdrInput).trim();
    if (!signedXdr) return;

    if (unsignedXdr && signedXdr === unsignedXdr.trim()) {
      await signWithFreighter();
      return;
    }

    setLoading(true);
    setSubmitErrorDetails(null);
    try {
      const submitResponse = await fetch("/api/stellar/submit-signed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedXdr,
          decisionId: authorizedAuditEntryId,
          quoteExpiresAt: paymentQuoteExpiresAt,
          buildAuthorization: paymentBuildAuthorization,
        }),
      });

      const submitPayload = (await submitResponse.json()) as {
        error?: string;
        explorerUrl?: string;
        payment?: { hash: string };
        explanation?: string;
        nextStep?: string;
        resultCode?: string;
        operationCodes?: string[];
      };

      if (!submitResponse.ok || submitPayload.error || !submitPayload.payment) {
        setMessage(submitPayload.error ?? "Submit failed.");
        if (submitPayload.explanation) {
          setSubmitErrorDetails({
            explanation: submitPayload.explanation,
            nextStep: submitPayload.nextStep,
            resultCode: submitPayload.resultCode,
            operationCodes: submitPayload.operationCodes,
          });
        }
        pushToast("error", "Transaction submission failed.");
        return;
      }

      const explorerUrl = submitPayload.explorerUrl ?? getExplorerUrl(submitPayload.payment.hash);
      setLastTxExplorerUrl(explorerUrl);
      setMessage(`Payment submitted: ${explorerUrl}`);
      pushToast("success", "Transaction submitted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Submit failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Toasts */}
      <div className="fixed left-4 right-4 top-20 z-50 space-y-2 sm:left-auto sm:right-4 sm:max-w-sm">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cn(
              "rounded-xl border px-4 py-2.5 text-sm shadow-xl backdrop-blur",
              toast.kind === "success"
                ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-100"
                : "border-rose-500/30 bg-rose-500/15 text-rose-100"
            )}
          >
            {toast.text}
          </div>
        ))}
      </div>

      <Stepper steps={WIZARD_STEPS} currentStep={step} />

      {!sessionLoading && !isOperator ? (
        <Alert className="border-amber-500/25 bg-amber-500/8">
          <AlertTitle>Viewer mode</AlertTitle>
          <AlertDescription>Login as operator to run evaluations and payments.</AlertDescription>
        </Alert>
      ) : null}

      {/* Step 1: Intent */}
      {step === 1 ? (
        <Card>
          <CardHeader>
            <CardTitle>Define intent</CardTitle>
            <CardDescription>Pick a demo scenario or generate an action with AI.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-1 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.35)] p-1">
              {(["scenario", "ai"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setIntentMode(mode)}
                  className={cn(
                    "flex-1 rounded-lg py-2 text-sm font-medium transition",
                    intentMode === mode
                      ? "bg-[hsl(var(--accent)/0.12)] text-[hsl(var(--accent))]"
                      : "text-[hsl(var(--muted-foreground))]"
                  )}
                >
                  {mode === "scenario" ? "Demo scenario" : "AI planner"}
                </button>
              ))}
            </div>

            {intentMode === "scenario" ? (
              <div className="space-y-2">
                {demoScenarios.map((scenario) => (
                  <button
                    key={scenario.id}
                    type="button"
                    onClick={() => setSelectedScenarioId(scenario.id)}
                    className={cn(
                      "w-full rounded-xl border p-4 text-left transition",
                      selectedScenarioId === scenario.id
                        ? "border-[hsl(var(--accent)/0.4)] bg-[hsl(var(--accent)/0.06)]"
                        : "border-[hsl(var(--border))] hover:border-[hsl(var(--accent)/0.2)]"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="min-w-0 flex-1 font-medium break-words">{scenario.title}</p>
                      <div className="shrink-0">
                        <DecisionBadge decision={scenario.expectedDecision} />
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
                      {scenario.description}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <Input
                  value={agentGoal}
                  onChange={(e) => setAgentGoal(e.target.value)}
                  placeholder="Agent goal"
                />
                <textarea
                  className="min-h-24 w-full rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring)/0.4)]"
                  value={agentContext}
                  onChange={(e) => setAgentContext(e.target.value)}
                  placeholder="Additional context"
                />
                <Button
                  variant="outline"
                  onClick={generateActionWithAi}
                  disabled={writeDisabled || generatingAction}
                  className="gap-2"
                >
                  {generatingAction ? (
                    <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles aria-hidden="true" className="h-4 w-4" />
                  )}
                  Generate action
                </Button>
                {generatedAction ? (
                  <div className="rounded-xl border border-[hsl(var(--accent)/0.2)] bg-[hsl(var(--accent)/0.05)] p-4 text-sm">
                    <p className="font-medium">{generatedAction.name}</p>
                    <p className="mt-1 text-[hsl(var(--muted-foreground))]">
                      {generatedAction.amountXLM} XLM → {generatedAction.domain}
                    </p>
                  </div>
                ) : null}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={() => setStep(2)}
                disabled={intentMode === "ai" && !generatedAction}
                className="gap-2"
              >
                Continue <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Step 2: Evaluate */}
      {step === 2 ? (
        <Card>
          <CardHeader>
            <CardTitle>Evaluate</CardTitle>
            <CardDescription>Run policy and risk checks on the selected intent.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeAction ? (
              <div className="rounded-xl bg-[hsl(var(--muted)/0.35)] p-4 text-sm">
                <p className="font-medium">{activeAction.name}</p>
                <p className="text-[hsl(var(--muted-foreground))]">
                  {activeAction.amountXLM} XLM → {activeAction.domain}
                </p>
              </div>
            ) : null}

            <Button
              onClick={() => runDecision(false)}
              disabled={writeDisabled}
              className="w-full gap-2"
            >
              {loading ? (
                <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              ) : (
                <Play aria-hidden="true" className="h-4 w-4" />
              )}
              Run evaluation
            </Button>

            <DecisionResultView result={decisionData?.result} />

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)} className="gap-2">
                <ChevronLeft aria-hidden="true" className="h-4 w-4" /> Back
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Step 3: Approve */}
      {step === 3 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Hand aria-hidden="true" className="h-5 w-5 text-violet-400" />
              Human approval
            </CardTitle>
            <CardDescription>Operator confirmation required before execution.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {decisionData ? (
              <>
                <DecisionResultView result={decisionData.result} />
                <Button
                  onClick={() => runDecision(true)}
                  disabled={writeDisabled || !canHumanApprove}
                  className="w-full"
                >
                  Approve & continue
                </Button>
              </>
            ) : null}
            <Button variant="ghost" onClick={() => setStep(2)} className="gap-2">
              <ChevronLeft aria-hidden="true" className="h-4 w-4" /> Back
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Step 4: Execute */}
      {step === 4 ? (
        <Card>
          <CardHeader>
            <CardTitle>Execute payment</CardTitle>
            <CardDescription>
              Build XDR, sign with Freighter, submit to Stellar testnet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {decisionData && activeAction ? (
              <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.35)] p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                  Payment summary
                </p>
                <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <p className="text-2xl font-semibold tracking-tight sm:text-3xl">
                    {sendAmount ?? "—"}{" "}
                    <span className="text-lg font-normal text-[hsl(var(--muted-foreground))]">
                      XLM
                    </span>
                  </p>
                  <div className="flex">
                    <span className="rounded-full border border-[hsl(var(--border))] px-2.5 py-0.5 text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                      Stellar Testnet
                    </span>
                  </div>
                </div>
                <div className="mt-4 space-y-2 text-sm">
                  <p>
                    <span className="text-[hsl(var(--muted-foreground))]">Action: </span>
                    {activeAction.name}
                  </p>
                  <p className="font-mono text-xs break-all">
                    <span className="font-sans text-[hsl(var(--muted-foreground))]">To: </span>
                    {destinationPreview || "Enter destination below"}
                  </p>
                  {sourcePublicKey ? (
                    <p className="font-mono text-xs break-all">
                      <span className="font-sans text-[hsl(var(--muted-foreground))]">From: </span>
                      {sourcePublicKey}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {decisionData ? (
              <div className="flex items-center gap-3 rounded-xl bg-[hsl(var(--muted)/0.35)] p-4">
                <DecisionBadge decision={decisionData.result.decision} />
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  Cleared for wallet signing
                </p>
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                  Amount (XLM)
                </label>
                <Input
                  type="number"
                  min="0.0000001"
                  step="0.0000001"
                  value={executeAmount}
                  onChange={(e) => {
                    setExecuteAmount(e.target.value);
                    resetPreparedXdr();
                  }}
                  placeholder={evaluatedAmount != null ? String(evaluatedAmount) : "5"}
                />
                {evaluatedAmount != null && sendAmount != null && sendAmount !== evaluatedAmount ? (
                  <p className="text-xs text-[hsl(var(--muted-foreground))]">
                    Policy evaluated for {evaluatedAmount} XLM — you are sending {sendAmount} XLM.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                  Destination address
                </label>
                <Input
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value);
                    resetPreparedXdr();
                  }}
                  placeholder="G... destination public key"
                />
              </div>
            </div>

            {unsignedXdr ? (
              <Alert className="border-emerald-500/25 bg-emerald-500/8">
                <AlertTitle>XDR prepared</AlertTitle>
                <AlertDescription>
                  {sendAmount} XLM will be sent to{" "}
                  <span className="font-mono">{truncateMiddle(destinationPreview, 10, 10)}</span>.
                  Use <strong>Sign & submit</strong> to open Freighter.
                </AlertDescription>
              </Alert>
            ) : null}

            {signError ? (
              <Alert className="border-rose-500/30 bg-rose-500/10" role="alert">
                <AlertTitle className="flex items-center gap-2 text-rose-200">
                  <ShieldAlert aria-hidden="true" className="h-4 w-4" />
                  {SIGN_ERROR_TITLES[signError.code]}
                </AlertTitle>
                <AlertDescription className="space-y-2 text-rose-100/90">
                  <p>{signError.message}</p>
                  <p className="text-xs text-rose-100/70">{SIGN_ERROR_HINTS[signError.code]}</p>
                  {unsignedXdr ? (
                    <p className="text-xs text-rose-100/60">
                      Prepared XDR is preserved — retry without rebuilding.
                    </p>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                variant="outline"
                onClick={prepareStellarPaymentXdr}
                disabled={writeDisabled || !decisionData || !destinationPreview || !executeAmount}
                className="w-full gap-2 sm:w-auto"
              >
                {preparingXdr ? (
                  <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                ) : null}
                {preparingXdr ? "Preparing XDR..." : "Prepare XDR"}
              </Button>
              {signError && unsignedXdr ? (
                <Button
                  onClick={signWithFreighter}
                  disabled={writeDisabled}
                  className="w-full gap-2 sm:w-auto"
                >
                  {loading ? (
                    <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCcw aria-hidden="true" className="h-4 w-4" />
                  )}
                  Retry sign
                </Button>
              ) : (
                <Button
                  onClick={() =>
                    signedXdrInput.trim() && signedXdrInput.trim() !== unsignedXdr.trim()
                      ? submitSignedXdr()
                      : signWithFreighter()
                  }
                  disabled={writeDisabled || (!signedXdrInput.trim() && !unsignedXdr)}
                  className="w-full gap-2 sm:w-auto"
                >
                  {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
                  Sign & submit
                </Button>
              )}
            </div>

            {lastTxExplorerUrl ? (
              <Alert>
                <AlertTitle>Transaction submitted</AlertTitle>
                <AlertDescription>
                  <a
                    href={lastTxExplorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all underline"
                  >
                    {lastTxExplorerUrl}
                  </a>
                </AlertDescription>
              </Alert>
            ) : null}

            <Button
              variant="ghost"
              onClick={() => setStep(decisionData?.result.decision === "REQUIRE_APPROVAL" ? 3 : 2)}
              className="gap-2"
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" /> Back
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {message ? (
        <Alert
          className={cn(
            "border-[hsl(var(--accent)/0.2)] bg-[hsl(var(--accent)/0.05)]",
            submitErrorDetails && "border-rose-500/30 bg-rose-500/10 text-rose-200"
          )}
        >
          <AlertTitle className="flex items-center gap-2">
            <ShieldAlert aria-hidden="true" className="h-4 w-4" />
            Status
          </AlertTitle>
          <AlertDescription>
            <div className="space-y-2">
              <p>{message}</p>
              {submitErrorDetails ? (
                <div className="mt-3 space-y-1 rounded-md border border-rose-500/20 bg-rose-500/10 p-3">
                  {submitErrorDetails.explanation ? (
                    <p className="text-sm">{submitErrorDetails.explanation}</p>
                  ) : null}
                  {submitErrorDetails.nextStep ? (
                    <p className="text-sm font-medium text-rose-100">
                      {submitErrorDetails.nextStep}
                    </p>
                  ) : null}
                  <p className="mt-2 font-mono text-[10px] opacity-70">
                    Raw codes: tx {submitErrorDetails.resultCode}
                    {submitErrorDetails.operationCodes?.length
                      ? `, ops: ${submitErrorDetails.operationCodes.join(", ")}`
                      : ""}
                  </p>
                </div>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
