"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const READINESS_POLL_MS = 30_000;

export type DashboardReadiness =
  { status: "checking" } | { status: "ready" } | { status: "not_ready"; failingChecks: string[] };

export const DASHBOARD_ACTIONS = [
  { id: "run-evaluation", label: "Run evaluation", href: "/console" },
  { id: "pay", label: "Pay", href: "/console" },
  { id: "fund", label: "Fund wallet", href: "/wallet" },
  { id: "activate-policy", label: "Activate policy", href: "/policies" },
] as const;

/**
 * Reads the readiness verdict the health route computed. Anything short of an
 * explicit `ready: true` keeps the actions gated.
 */
export function readinessFromHealthBody(body: unknown): DashboardReadiness {
  const payload = (body ?? {}) as { ready?: unknown; failingChecks?: unknown };

  if (payload.ready === true) {
    return { status: "ready" };
  }

  const failingChecks = Array.isArray(payload.failingChecks)
    ? payload.failingChecks.filter((name): name is string => typeof name === "string")
    : [];

  return {
    status: "not_ready",
    failingChecks: failingChecks.length > 0 ? failingChecks : ["health_unavailable"],
  };
}

async function fetchReadiness(): Promise<DashboardReadiness> {
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

export function DashboardActions() {
  const [readiness, setReadiness] = useState<DashboardReadiness>({ status: "checking" });
  // Id of the newest readiness request. A response is applied only if no newer
  // request was started after it, so a slow, older "ready" can never re-show
  // actions that a newer "not ready" hid.
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
    const interval = window.setInterval(() => void loadReadiness(), READINESS_POLL_MS);

    return () => {
      window.clearInterval(interval);
      // Invalidate any request still in flight.
      latestRequestRef.current += 1;
    };
  }, [loadReadiness]);

  const ready = readiness.status === "ready";

  return (
    <Card>
      <CardHeader>
        <CardDescription>Payment and policy actions</CardDescription>
        <CardTitle className="text-lg">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {readiness.status === "checking" ? (
          <p className="flex items-center gap-2 text-sm text-[hsl(var(--muted-foreground))]">
            <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            Checking service readiness...
          </p>
        ) : null}

        {readiness.status === "not_ready" ? (
          <Alert role="status" className="border-amber-500/25 bg-amber-500/8">
            <AlertTitle className="flex items-center gap-2">
              <ShieldAlert aria-hidden="true" className="h-4 w-4" />
              Actions paused until the health check passes
            </AlertTitle>
            <AlertDescription data-testid="failing-checks">
              Failing checks: {readiness.failingChecks.join(", ")}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {DASHBOARD_ACTIONS.map((action) =>
            ready ? (
              <Link key={action.id} href={action.href}>
                <Button className="gap-2" data-action={action.id}>
                  {action.label} <ArrowRight aria-hidden="true" className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <Button
                key={action.id}
                className="gap-2"
                data-action={action.id}
                disabled
                aria-disabled="true"
              >
                {action.label}
              </Button>
            )
          )}
        </div>

        {readiness.status === "checking" ? null : (
          <Button variant="ghost" size="sm" onClick={() => void loadReadiness()}>
            Recheck readiness
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
