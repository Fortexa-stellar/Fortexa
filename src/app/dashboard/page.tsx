import Link from "next/link";
import { Shield, AlertTriangle, BadgeCheck, Wallet } from "lucide-react";
import { cookies } from "next/headers";

import { ActivityTimeline } from "@/components/activity-timeline";
import { DashboardActions } from "@/components/dashboard-actions";
import { WalletStatusCard } from "@/components/wallet-status-card";
import { StatCard } from "@/components/ui/stat-card";
import { AUTH_COOKIE_KEY, verifySessionToken } from "@/lib/auth/session";
import { defaultPolicyConfig } from "@/lib/policy/engine";
import { demoScenarios } from "@/lib/scenarios/seed";
import { listAuditEntries } from "@/lib/storage/audit-store";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(AUTH_COOKIE_KEY)?.value;
  const session = sessionToken ? verifySessionToken(sessionToken) : null;
  const userId = session?.userId;
  const entries = userId ? await listAuditEntries(userId) : [];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Policy posture, wallet status, and recent activity at a glance.
          </p>
        </div>
      </div>

      <WalletStatusCard compact />

      {/* Payment and policy actions render only once /api/health reports ready. */}
      <DashboardActions />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Policy guards"
          value="12"
          sub="Domain, tool, spend, and threshold rules"
          icon={Shield}
        />
        <StatCard
          label="Scenarios"
          value={`${demoScenarios.length}`}
          sub="Curated demo journeys"
          icon={BadgeCheck}
        />
        <StatCard
          label="Risk threshold"
          value={`${defaultPolicyConfig.riskThreshold}`}
          sub="Manual approval trigger"
          icon={AlertTriangle}
        />
        <StatCard label="Network" value="Testnet" sub="Wallet-native XDR path" icon={Wallet} />
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Recent activity</h2>
          <Link
            href="/settings?tab=activity"
            className="text-sm text-[hsl(var(--accent))] hover:underline"
          >
            View all
          </Link>
        </div>
        <ActivityTimeline entries={entries} compact />
      </section>
    </div>
  );
}
