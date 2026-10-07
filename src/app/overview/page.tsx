"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  CreditCard,
  Loader2,
  ShieldAlert,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";

export const OVERVIEW_READINESS_POLL_MS = 30_000;

export type OverviewReadiness =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "not_ready"; failingChecks: string[] };

export type OverviewPaymentTotalsData = {
  totalPayments: number | string;
  totalVolumeXLM: number | string;
  settledPayments?: number | string;
  activeGuards?: number | string;
};

export const DEFAULT_OVERVIEW_TOTALS: OverviewPaymentTotalsData = {
  totalPayments: 42,
  totalVolumeXLM: "1,250 XLM",
  settledPayments: 38,
  activeGuards: 12,
};

export const OVERVIEW_PAYMENT_SHORTCUTS = [
  { id: "pay", label: "Pay", href: "/console" },
  { id: "fund", label: "Fund wallet", href: "/wallet" },
  { id: "run-evaluation", label: "Run evaluation", href: "/console" },
  { id: "activate-policy", label: "Activate policy", href: "/policies" },
] as const;

/**
 * Reads the readiness verdict computed by the health route.
 * Anything other than explicit ready === true keeps overview metrics gated.
 */
export function readinessFromHealthBody(body: unknown): OverviewReadiness {
  const payload = (body ?? {}) as { ready?: unknown; failingChecks?: unknown };

  if (payload.ready === true) {
    return { status: "ready" };
  }

  const failingChecks = Array.isArray(payload.failingChecks)
    ? payload.failingChecks.filter(
        (name): name is string => typeof name === "string"
      )
    : [];

  return {
    status: "not_ready",
    failingChecks:
      failingChecks.length > 0 ? failingChecks : ["health_unavailable"],
  };
}

async function fetchReadiness(): Promise<OverviewReadiness> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      return { status: "not_ready", failingChecks: ["health_unavailable"] };
    }
    return readinessFromHealthBody(await response.json());
  } catch {
    return { status: "not_ready", failingChecks: ["health_unreachable"] };
  }
}

export interface OverviewPageProps {
  fixtureTotals?: OverviewPaymentTotalsData;
}

export default function OverviewPage({
  fixtureTotals = DEFAULT_OVERVIEW_TOTALS,
}: OverviewPageProps = {}) {
  const [readiness, setReadiness] = useState<OverviewReadiness>({
    status: "checking",
  });
  // Monotonic request counter: drop out-of-order or stale responses
  const latestRequestRef = useRef(0);

  const loadReadiness = useCallback(async () => {
    latestRequestRef.current += 1;
    const requestId = latestRequestRef.current;

    const next = await fetchReadiness();

    if (requestId === latestRequestRef.current) {
      setReadiness(next);
    }
  }, []);

  useEffect(() => {
    void loadReadiness();
    const interval = window.setInterval(
      () => void loadReadiness(),
      OVERVIEW_READINESS_POLL_MS
    );

    return () => {
      window.clearInterval(interval);
      latestRequestRef.current += 1;
    };
  }, [loadReadiness]);

  const ready = readiness.status === "ready";

  return (
    <main className="mx-auto max-w-6xl space-y-8">
      <Card className="premium-panel border-cyan-300/20 bg-[linear-gradient(180deg,rgba(11,22,42,0.82),rgba(9,14,26,0.84))]">
        <CardHeader>
          <CardDescription>Overview</CardDescription>
          <CardTitle className="text-2xl">
            Autonomous Payment Command Center
          </CardTitle>
          <CardDescription>
            Live posture for policy controls, wallet trust boundary, risk
            governance, and execution readiness.
          </CardDescription>
        </CardHeader>
      </Card>

      {readiness.status === "checking" ? (
        <Card>
          <CardContent className="py-6">
            <p className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              Checking service readiness before loading payment metrics...
            </p>
          </CardContent>
        </Card>
      ) : null}

      {readiness.status === "not_ready" ? (
        <Alert role="status" className="border-amber-500/25 bg-amber-500/8">
          <AlertTitle className="flex items-center gap-2">
            <ShieldAlert aria-hidden="true" className="h-4 w-4" />
            Payment totals and shortcuts paused until the health check passes
          </AlertTitle>
          <AlertDescription data-testid="failing-checks">
            Failing checks: {readiness.failingChecks.join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      {ready ? (
        <>
          <section data-testid="overview-totals" className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Payment Totals</h2>
            </div>
            <div
              data-testid="payment-totals"
              className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
            >
              <StatCard
                label="Total Payments"
                value={String(fixtureTotals.totalPayments)}
                sub="Evaluated & processed payments"
                icon={CreditCard}
              />
              <StatCard
                label="Total Volume"
                value={String(fixtureTotals.totalVolumeXLM)}
                sub="Settled native XLM volume"
                icon={TrendingUp}
              />
              <StatCard
                label="Settled Payments"
                value={String(fixtureTotals.settledPayments ?? "0")}
                sub="Confirmed ledger executions"
                icon={CheckCircle2}
              />
              <StatCard
                label="Active Guards"
                value={String(fixtureTotals.activeGuards ?? "12")}
                sub="Policy protection rules"
                icon={Wallet}
              />
            </div>
          </section>

          <Card data-testid="payment-shortcuts">
            <CardHeader>
              <CardDescription>Direct execution shortcuts</CardDescription>
              <CardTitle className="text-lg">Payment Shortcuts</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {OVERVIEW_PAYMENT_SHORTCUTS.map((action) => (
                  <Link key={action.id} href={action.href}>
                    <Button className="gap-2" data-action={action.id}>
                      {action.label}{" "}
                      <ArrowRight aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </main>
  );
}
