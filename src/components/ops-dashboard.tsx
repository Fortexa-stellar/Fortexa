"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  HelpCircle,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { MetricsSnapshot, OpsCounters } from "@/lib/observability/metrics";

type BlocklistHealth = {
  configured: boolean;
  lastRefreshAt: string | null;
  domainCount: number;
  lastError: string | null;
};

type HealthResponse = {
  ok: boolean;
  service: string;
  timestamp: string;
  env: {
    hasGroqKey: boolean;
    hasAuthSecret: boolean;
    hasHorizonUrl: boolean;
  };
  blocklist: BlocklistHealth;
  dependencies: {
    storage: string;
    horizon: string;
    blocklist: string;
    groq: string;
  };
};

type IntegrityResponse = {
  valid: boolean;
  checkedEntries: number;
  legacyEntries: number;
  firstBrokenEntryId: string | null;
  reason: string | null;
  scope: "mine" | "all";
  userId?: string;
  timestamp: string;
};

type MetricsResponse = MetricsSnapshot;

type AuditExportResponse = {
  scope: "all";
  exportedBy: string;
  entriesByUser: Record<string, Array<{ stellarTxHash?: string }>>;
};

type MetricSample = {
  label: string;
  requests: number;
  errors: number;
  errorRatePct: number;
};

/**
 * Zeroed counters used before the first snapshot arrives (and whenever the
 * snapshot has no recorded activity). Rendering zeroes keeps the cards stable:
 * no spinner can hang waiting on data that will never exist.
 */
const EMPTY_COUNTERS: OpsCounters = {
  allow: 0,
  deny: 0,
  rateLimit: 0,
  submitFailures: 0,
};

function readCounters(snapshot: MetricsResponse | null): OpsCounters {
  // Tolerate a snapshot from a server that predates the counters block.
  return snapshot?.counters ?? EMPTY_COUNTERS;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function formatShortTime(iso: string) {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds()
  ).padStart(2, "0")}`;
}

function DependencyBadge({ name, status }: { name: string; status: string }) {
  const isHealthy = status === "healthy";
  const isDegraded = status === "degraded";

  const colorClass = isHealthy
    ? "bg-emerald-900/30 text-emerald-300 border-emerald-800"
    : isDegraded
      ? "bg-amber-900/30 text-amber-300 border-amber-800"
      : "bg-neutral-900/30 text-neutral-400 border-neutral-800";

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {isHealthy ? (
        <CheckCircle2 aria-hidden="true" className="h-3 w-3" />
      ) : isDegraded ? (
        <AlertTriangle aria-hidden="true" className="h-3 w-3" />
      ) : (
        <HelpCircle aria-hidden="true" className="h-3 w-3" />
      )}
      {name}
    </div>
  );
}

function CounterTile({
  label,
  value,
  testId,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: number;
  testId: string;
  hint: string;
  tone: string;
  icon: ReactNode;
}) {
  return (
    <div
      className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.15)] p-3"
      data-testid={`ops-counter-${testId}-tile`}
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
        {icon}
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold ${tone}`} data-testid={`ops-counter-${testId}`}>
        {value}
      </div>
      <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">{hint}</p>
    </div>
  );
}

export function OpsDashboard({ initialMetrics }: { initialMetrics?: MetricsResponse }) {
  // Seeded from the in-process metrics snapshot read by the server loader, so the
  // counters below come from the exact object `/api/metrics` serialises.
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(initialMetrics ?? null);
  const [integrity, setIntegrity] = useState<IntegrityResponse | null>(null);
  const [txCount, setTxCount] = useState<number | null>(null);
  const [samples, setSamples] = useState<MetricSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [txLoading, setTxLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [integrityLoading, setIntegrityLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadTxCount() {
      setTxLoading(true);

      try {
        const auditResponse = await fetch("/api/audit/export?format=json&scope=all", {
          cache: "no-store",
        });

        if (!auditResponse.ok) {
          throw new Error("Failed to fetch signed transaction count.");
        }

        const auditPayload = (await auditResponse.json()) as AuditExportResponse;
        const extractedTxCount = Object.values(auditPayload.entriesByUser)
          .flatMap((entries) => entries)
          .filter((entry) => Boolean(entry.stellarTxHash)).length;

        if (cancelled) {
          return;
        }

        setTxCount(extractedTxCount);
      } catch {
        if (!cancelled) {
          setTxCount(null);
        }
      } finally {
        if (!cancelled) {
          setTxLoading(false);
        }
      }
    }

    async function loadIntegrity() {
      try {
        const integrityResponse = await fetch("/api/audit/integrity?scope=all", {
          cache: "no-store",
        });

        if (!integrityResponse.ok) {
          throw new Error("Failed to fetch audit integrity.");
        }

        const integrityPayload = (await integrityResponse.json()) as IntegrityResponse;
        if (cancelled) {
          return;
        }
        setIntegrity(integrityPayload);
      } catch {
        if (!cancelled) {
          setIntegrity(null);
        }
      } finally {
        if (!cancelled) {
          setIntegrityLoading(false);
        }
      }
    }

    async function loadCore() {
      try {
        const [healthResponse, metricsResponse] = await Promise.all([
          fetch("/api/health", { cache: "no-store" }),
          fetch("/api/metrics", { cache: "no-store" }),
        ]);

        if (!healthResponse.ok || !metricsResponse.ok) {
          throw new Error("Failed to fetch ops telemetry.");
        }

        const healthPayload = (await healthResponse.json()) as HealthResponse;
        const metricsPayload = (await metricsResponse.json()) as MetricsResponse;

        if (cancelled) {
          return;
        }

        setHealth(healthPayload);
        setMetrics(metricsPayload);
        setSamples((current) => {
          const next = [
            ...current,
            {
              label: formatShortTime(metricsPayload.timestamp),
              requests: metricsPayload.totals.totalCount,
              errors: metricsPayload.totals.errorCount,
              errorRatePct: Number((metricsPayload.totals.errorRate * 100).toFixed(2)),
            },
          ];

          return next.slice(-15);
        });
        setError(null);
        setLastRefreshed(new Date().toISOString());
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Ops data fetch failed.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }

      void loadTxCount();
    }

    void loadCore();
    void loadIntegrity();
    const interval = window.setInterval(() => {
      void loadCore();
      void loadIntegrity();
    }, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const hotRoutes = useMemo(() => {
    if (!metrics) {
      return [];
    }

    return [...metrics.routes]
      .sort((left, right) => right.totalCount - left.totalCount)
      .slice(0, 5);
  }, [metrics]);

  // Allow/deny, rate-limit and submit-failure totals are read straight off the
  // metrics snapshot. They are never recomputed from the audit table.
  const counters = useMemo(() => readCounters(metrics), [metrics]);

  return (
    <div className="space-y-6">
      {error ? (
        <Card>
          <CardContent className="py-6 text-sm text-red-300">{error}</CardContent>
        </Card>
      ) : null}

      <section
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-4"
        data-testid="ops-snapshot-counters"
      >
        <CounterTile
          label="Allowed"
          value={counters.allow}
          testId="allow"
          hint="APPROVE + WARN decisions"
          tone="text-emerald-300"
          icon={<ShieldCheck aria-hidden="true" className="h-3 w-3" />}
        />
        <CounterTile
          label="Denied"
          value={counters.deny}
          testId="deny"
          hint="REQUIRE_APPROVAL + BLOCK decisions"
          tone="text-red-300"
          icon={<ShieldOff aria-hidden="true" className="h-3 w-3" />}
        />
        <CounterTile
          label="Rate limited"
          value={counters.rateLimit}
          testId="rate-limit"
          hint="Requests rejected with HTTP 429"
          tone="text-amber-300"
          icon={<AlertTriangle aria-hidden="true" className="h-3 w-3" />}
        />
        <CounterTile
          label="Submit failures"
          value={counters.submitFailures}
          testId="submit-failures"
          hint="Signed submissions that failed to settle"
          tone="text-fuchsia-300"
          icon={<ShieldAlert aria-hidden="true" className="h-3 w-3" />}
        />
        <p className="text-xs text-[hsl(var(--muted-foreground))] md:col-span-2 xl:col-span-4">
          Source: in-process metrics snapshot
          {metrics?.timestamp ? ` (${formatShortTime(metrics.timestamp)})` : ""} — identical to{" "}
          <code className="font-mono">GET /api/metrics</code>. Empty snapshot reads as zeroes.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Service Health</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <CheckCircle2 aria-hidden="true" className="h-5 w-5 text-emerald-300" />
              {health?.ok ? "Healthy" : loading ? "Loading" : "Unknown"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm text-[hsl(var(--muted-foreground))]">
              {health?.timestamp ?? "-"}
            </div>
            {lastRefreshed ? (
              <div
                className="text-xs text-[hsl(var(--muted-foreground))] opacity-70"
                id="ops-last-refreshed"
                data-testid="last-refreshed"
              >
                Last refreshed: {formatShortTime(lastRefreshed)}
              </div>
            ) : null}
            {health?.dependencies ? (
              <div className="flex flex-wrap gap-2">
                <DependencyBadge name="Storage" status={health.dependencies.storage} />
                <DependencyBadge name="Horizon" status={health.dependencies.horizon} />
                <DependencyBadge name="Blocklist" status={health.dependencies.blocklist} />
                <DependencyBadge name="Groq" status={health.dependencies.groq} />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Total Requests</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Database aria-hidden="true" className="h-5 w-5 text-blue-300" />
              {metrics?.totals.totalCount ?? 0}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[hsl(var(--muted-foreground))]">
            Last scrape: {metrics?.timestamp ? formatShortTime(metrics.timestamp) : "-"}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Error Rate</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <AlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-300" />
              {metrics ? formatPct(metrics.totals.errorRate) : "0.00%"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[hsl(var(--muted-foreground))]">
            Errors: {metrics?.totals.errorCount ?? 0}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Signed TX Count</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Clock3 aria-hidden="true" className="h-5 w-5 text-fuchsia-300" />
              {txLoading ? "Loading" : (txCount ?? "-")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-[hsl(var(--muted-foreground))]">
            From audit export (`scope=all`)
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Audit Integrity</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              {integrity ? (
                integrity.valid ? (
                  <ShieldCheck className="h-5 w-5 text-emerald-300" />
                ) : (
                  <ShieldAlert className="h-5 w-5 text-red-400" />
                )
              ) : (
                <Shield className="h-5 w-5 text-[hsl(var(--muted-foreground))]" />
              )}
              {integrity
                ? integrity.valid
                  ? "Valid"
                  : "Tampered"
                : integrityLoading
                  ? "Loading"
                  : "Unknown"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-[hsl(var(--muted-foreground))]">
            {integrity ? (
              <>
                <p>
                  Checked entries: <span className="text-white">{integrity.checkedEntries}</span>
                </p>
                {integrity.legacyEntries > 0 ? (
                  <p>Legacy entries: {integrity.legacyEntries}</p>
                ) : null}
                {integrity.valid ? null : (
                  <div className="rounded-md border border-red-400/40 bg-red-500/10 p-2 text-red-300">
                    <p>
                      First broken entry:{" "}
                      <span className="font-mono text-white">
                        {integrity.firstBrokenEntryId ?? "unknown"}
                      </span>
                    </p>
                    {integrity.reason ? <p className="mt-1">{integrity.reason}</p> : null}
                  </div>
                )}
                <p>Last verified: {new Date(integrity.timestamp).toLocaleString()}</p>
              </>
            ) : (
              <p>Last verified: —</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Blocklist Feed</CardDescription>
            <CardTitle className="flex items-center gap-2 text-2xl">
              {health?.blocklist.configured ? (
                <Shield aria-hidden="true" className="h-5 w-5 text-emerald-300" />
              ) : (
                <ShieldOff aria-hidden="true" className="h-5 w-5 text-amber-400" />
              )}
              {health
                ? health.blocklist.configured
                  ? "Active"
                  : "Unconfigured"
                : loading
                  ? "Loading"
                  : "-"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-[hsl(var(--muted-foreground))]">
            {health?.blocklist.configured ? (
              <>
                <p>Domains: {health.blocklist.domainCount}</p>
                <p>
                  Last refresh:{" "}
                  {health.blocklist.lastRefreshAt
                    ? new Date(health.blocklist.lastRefreshAt).toLocaleString()
                    : "never"}
                </p>
                {health.blocklist.lastError ? (
                  <p className="text-red-300">Last error: {health.blocklist.lastError}</p>
                ) : null}
              </>
            ) : (
              <p>Set FORTEXA_BLOCKLIST_URL to enable threat-intel feed.</p>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Traffic Trend</CardTitle>
            <CardDescription>Rolling 15 samples (8s interval)</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-72 w-full min-w-0">
              {samples.length === 0 ? (
                <p className="text-sm text-[hsl(var(--muted-foreground))]">No samples yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height={288} minWidth={1}>
                  <LineChart data={samples}>
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
                    <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="requests"
                      stroke="#22d3ee"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      yAxisId="left"
                      type="monotone"
                      dataKey="errors"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="errorRatePct"
                      stroke="#ef4444"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Top Routes</CardTitle>
            <CardDescription>Highest request counts</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {hotRoutes.length === 0 ? (
              <p className="text-[hsl(var(--muted-foreground))]">No route metrics yet.</p>
            ) : (
              hotRoutes.map((route) => (
                <div
                  key={`${route.method}:${route.route}`}
                  className="rounded-lg border border-[hsl(var(--border))] p-2 text-[hsl(var(--muted-foreground))]"
                >
                  <p className="font-medium text-white">
                    {route.method} {route.route}
                  </p>
                  <p>
                    requests: {route.totalCount} · errors: {route.errorCount} · p95:{" "}
                    {route.p95DurationMs.toFixed(1)} ms
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
