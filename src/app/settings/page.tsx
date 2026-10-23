import { cookies } from "next/headers";

import { ActivityTimeline } from "@/components/activity-timeline";
import { OpsDashboard } from "@/components/ops-dashboard";
import { PolicyEditor } from "@/components/policy-editor";
import { ScenariosCatalog } from "@/components/scenarios-catalog";
import { evaluateScenarioCatalog } from "@/lib/scenarios/evaluate";
import { TabNav, type TabItem } from "@/components/ui/tab-nav";
import { WalletStatusCard } from "@/components/wallet-status-card";
import { AUTH_COOKIE_KEY, verifySessionToken } from "@/lib/auth/session";
import { getMetricsSnapshot } from "@/lib/observability/metrics";
import { listAuditEntries } from "@/lib/storage/audit-store";

const tabs: TabItem[] = [
  { id: "policies", label: "Policies", href: "/settings?tab=policies" },
  { id: "wallet", label: "Wallet", href: "/settings?tab=wallet" },
  { id: "scenarios", label: "Scenarios", href: "/settings?tab=scenarios" },
  { id: "ops", label: "Ops", href: "/settings?tab=ops" },
  { id: "activity", label: "Activity", href: "/settings?tab=activity" },
];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab = "policies" } = await searchParams;
  const activeTab = tabs.some((t) => t.id === tab) ? tab : "policies";

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(AUTH_COOKIE_KEY)?.value;
  const session = sessionToken ? verifySessionToken(sessionToken) : null;
  const userId = session?.userId;
  const entries = userId ? await listAuditEntries(userId) : [];
  const scenarioEvaluations = activeTab === "scenarios" ? await evaluateScenarioCatalog() : [];

  // Ops dashboard loader: read the in-process metrics snapshot directly so the
  // screen renders the same counters the `/api/metrics` scrape exports.
  const opsMetricsSnapshot = activeTab === "ops" ? getMetricsSnapshot() : null;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <TabNav tabs={tabs} activeTab={activeTab} />

      <section className="surface-elevated p-6" aria-label="Server network configuration">
        <h2 className="text-lg font-semibold">Server network</h2>
        <p className="mt-2 text-sm">Network: {inferStellarNetworkProfile(horizonUrl)}</p>
        <p className="text-sm">Network passphrase: {networkPassphrase}</p>
        <p className="text-sm">Configuration valid: {network.ok ? "yes" : "no"}</p>
        {!network.ok ? (
          <p role="alert" className="mt-2 text-sm text-red-400">
            Network mismatch: server Horizon and passphrase disagree. Saving is disabled.
          </p>
        ) : null}
      </section>

      {activeTab === "policies" ? (
        <PolicyEditor
          networkMatches={network.ok}
          networkFingerprint={getStellarNetworkFingerprint()}
        />
      ) : null}
      {activeTab === "wallet" ? (
        <div className="space-y-6">
          <WalletStatusCard />
          <div className="surface-elevated p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                Recent Activity
              </h3>
            </div>
            {entries.length > 0 ? (
              <ActivityTimeline entries={entries} compact />
            ) : (
              <div className="rounded-xl border border-dashed border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.2)] p-8 text-center">
                <p className="text-sm text-[hsl(var(--muted-foreground))]">
                  No visible activity for this wallet yet.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {activeTab === "scenarios" ? <ScenariosCatalog /> : null}
      {activeTab === "ops" && opsMetricsSnapshot ? (
        <OpsDashboard initialMetrics={opsMetricsSnapshot} />
      ) : null}
      {activeTab === "activity" ? <ActivityTimeline entries={entries} /> : null}
    </div>
  );
}
