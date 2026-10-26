"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, RefreshCw, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { resolveWalletCardState, type WalletCardState } from "@/lib/auth/session-wallet";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { truncateMiddle } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

type WalletData = {
  configured: boolean;
  userId?: string;
  source?: "external";
  provider?: string;
  publicKey?: string;
  balance?: string;
  message?: string;
  error?: string;
  network?: string;
};

/** Read the account currently selected in Freighter without prompting for access. */
async function readConnectedAccount(): Promise<string | null> {
  try {
    const { getAddress } = await import("@stellar/freighter-api");
    const result = await getAddress();
    return result.address ? result.address : null;
  } catch {
    return null;
  }
}

const STATUS_MESSAGES: Record<WalletCardState["status"], string> = {
  signed_out: "Signed out. Sign in with Freighter to bind your session wallet.",
  unbound: "No wallet is bound to this session. Sign in with Freighter to enable wallet actions.",
  not_connected: "Connect Freighter with your session wallet to enable wallet actions.",
  mismatch:
    "The connected Freighter account is not the wallet bound to this session. Pay and policy actions are disabled.",
  match: "Connected account matches the session wallet.",
};

export function WalletActionsPanel({
  state,
  revoking = false,
  onPay,
  onEditPolicy,
  onRevoke,
}: {
  state: WalletCardState;
  revoking?: boolean;
  onPay?: () => void;
  onEditPolicy?: () => void;
  onRevoke?: () => void;
}) {
  const tone =
    state.status === "mismatch"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
      : state.status === "match"
        ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-200"
        : "border-amber-500/20 bg-amber-500/5 text-amber-200/90";

  return (
    <div data-testid="wallet-actions" data-status={state.status} className="mt-4 space-y-3">
      <p
        role={state.status === "mismatch" ? "alert" : undefined}
        className={cn("rounded-xl border px-4 py-3 text-sm", tone)}
      >
        {STATUS_MESSAGES[state.status]}
        {state.status === "mismatch" && state.connectedAccount && state.sessionWallet ? (
          <span className="mt-1 block font-mono text-xs">
            Connected {truncateMiddle(state.connectedAccount, 6, 6)} · Session{" "}
            {truncateMiddle(state.sessionWallet, 6, 6)}
          </span>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" data-action="pay" onClick={onPay} disabled={!state.canPay}>
          Pay
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-action="policy"
          onClick={onEditPolicy}
          disabled={!state.canEditPolicy}
        >
          Edit policy
        </Button>
        {state.status !== "signed_out" ? (
          <Button
            size="sm"
            variant="danger"
            data-action="revoke"
            onClick={onRevoke}
            disabled={revoking}
          >
            {revoking ? "Revoking…" : "Revoke wallet"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function WalletStatusCard({
  compact = false,
  connectedAccount: connectedAccountOverride,
}: {
  compact?: boolean;
  /** Connected wallet account; read from Freighter when not provided. */
  connectedAccount?: string | null;
}) {
  const router = useRouter();
  const session = useAuthSession();
  const [detectedAccount, setDetectedAccount] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [data, setData] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let isActive = true;

    const loadWallet = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/stellar/balance");
        const payload = (await response.json()) as WalletData;
        if (isActive) {
          setData(payload);
        }
      } catch {
        if (isActive) {
          setData(null);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void loadWallet();

    if (connectedAccountOverride === undefined) {
      void readConnectedAccount().then((account) => {
        if (isActive) setDetectedAccount(account);
      });
    }

    return () => {
      isActive = false;
      if (copyResetTimeout.current) {
        clearTimeout(copyResetTimeout.current);
      }
    };
  }, [connectedAccountOverride]);

  const walletState = resolveWalletCardState({
    authenticated: session.authenticated,
    revoked,
    role: session.role,
    sessionWallet: session.wallet,
    connectedAccount:
      connectedAccountOverride === undefined ? detectedAccount : connectedAccountOverride,
  });

  async function handleRevoke() {
    setRevoking(true);
    try {
      const response = await fetch("/api/auth/wallet/revoke", { method: "DELETE" });
      if (response.ok) {
        setRevoked(true);
        setData(null);
        setDetectedAccount(null);
      }
    } finally {
      setRevoking(false);
    }
  }

  async function handleRefresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/stellar/balance");
      const payload = (await response.json()) as WalletData;
      setData(payload);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function copyPublicKey() {
    if (!data?.publicKey) return;
    await navigator.clipboard.writeText(data.publicKey);
    setCopied(true);
    if (copyResetTimeout.current) {
      clearTimeout(copyResetTimeout.current);
    }
    copyResetTimeout.current = setTimeout(() => setCopied(false), 2000);
  }

  if (compact) {
    return (
      <div className="surface-elevated flex items-center justify-between gap-4 p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--accent)/0.1)]">
            <Wallet className="h-5 w-5 text-[hsl(var(--accent))]" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Session wallet
            </p>
            {data?.publicKey && walletState.status !== "signed_out" ? (
              <p className="font-mono text-sm">{truncateMiddle(data.publicKey, 8, 8)}</p>
            ) : (
              <p className="text-sm text-[hsl(var(--muted-foreground))]">Not linked</p>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">Balance</p>
          <p className="text-lg font-semibold">
            {data?.balance ?? "—"}{" "}
            <span className="text-sm font-normal text-[hsl(var(--muted-foreground))]">XLM</span>
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
          aria-label={loading ? "Refreshing wallet…" : "Refresh wallet balance"}
          className="shrink-0"
        >
          <RefreshCw aria-hidden="true" className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>
    );
  }

  return (
    <div className="surface-elevated p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
            Wallet layer
          </p>
          <p className="text-lg font-semibold">Agent wallet</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading}>
          <RefreshCw
            aria-hidden="true"
            className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {data?.publicKey && walletState.status !== "signed_out" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-[hsl(var(--muted)/0.4)] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                Public key
              </p>
              <button
                type="button"
                onClick={copyPublicKey}
                aria-label={
                  copied ? "Wallet public key copied" : "Copy wallet public key to clipboard"
                }
                className="inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-2 text-[10px] font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))] transition-colors hover:border-[hsl(var(--border))] hover:bg-[hsl(var(--background))] hover:text-[hsl(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-2 focus-visible:ring-offset-[hsl(var(--background))]"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3" aria-hidden="true" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" aria-hidden="true" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <p className="mt-1 font-mono text-xs">{truncateMiddle(data.publicKey, 14, 14)}</p>
          </div>
          <div className="rounded-xl bg-[hsl(var(--muted)/0.4)] p-4">
            <p className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
              Balance
            </p>
            <p className="mt-1 text-xl font-semibold">
              {data.balance ?? "0"} <span className="text-sm font-normal">XLM</span>
            </p>
          </div>
          {data.network ? (
            <p className="text-xs text-[hsl(var(--muted-foreground))] sm:col-span-2">
              Network: {data.network}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200/90">
          {data?.error ??
            data?.message ??
            "No wallet linked. Sign in with Freighter to bind your session wallet."}
        </p>
      )}

      <WalletActionsPanel
        state={walletState}
        revoking={revoking}
        onPay={() => router.push("/console")}
        onEditPolicy={() => router.push("/settings?tab=policies")}
        onRevoke={() => void handleRevoke()}
      />
    </div>
  );
}
