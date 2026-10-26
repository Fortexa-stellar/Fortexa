"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Terminal,
  Settings,
  LogOut,
  Radio,
  Loader2,
} from "lucide-react";

import { AppWorkspaceBackground } from "@/components/app-workspace-background";
import { Button } from "@/components/ui/button";
import { useAuthSession } from "@/lib/auth/use-auth-session";
import { cn } from "@/lib/utils/cn";
import { truncateMiddle } from "@/lib/utils/format";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/console", label: "Console", icon: Terminal },
  { href: "/settings", label: "Settings", icon: Settings },
];

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/console": "Console",
  "/settings": "Settings",
};

function getPageTitle(pathname: string) {
  if (pathname.startsWith("/settings")) return "Settings";
  return pageTitles[pathname] ?? "Fortexa";
}

function SessionChip({
  loading,
  wallet,
  role,
}: {
  loading: boolean;
  wallet: string | null;
  role: "operator" | "viewer" | null;
}) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-1 text-xs text-[hsl(var(--muted-foreground))]">
        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
        Session
      </span>
    );
  }

  if (!wallet) {
    return null;
  }

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-1 font-mono text-xs">
      {truncateMiddle(wallet, 6, 6)}
      {role ? (
        <span className="rounded bg-[hsl(var(--accent)/0.12)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[hsl(var(--accent))]">
          {role}
        </span>
      ) : null}
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublicRoute = pathname === "/" || pathname === "/login";
  const { wallet, role, loading } = useAuthSession();
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    if (isPublicRoute) {
      document.body.classList.remove("app-shell");
      return;
    }

    document.body.classList.add("app-shell");
    return () => document.body.classList.remove("app-shell");
  }, [isPublicRoute]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Re-render server components against the cleared session so no stale
      // authenticated view survives the logout.
      router.refresh();
      router.push("/login");
    }
  }

  if (isPublicRoute) {
    return <>{children}</>;
  }

  const pageTitle = getPageTitle(pathname);

  return (
    <div className="relative flex min-h-screen">
      <AppWorkspaceBackground />

      <aside className="glass-sidebar fixed inset-y-0 left-0 z-40 hidden w-[220px] flex-col lg:flex">
        <Link
          href="/"
          className="flex items-center gap-3 border-b border-[hsl(var(--border)/0.5)] px-5 py-5 transition-opacity hover:opacity-80"
        >
          <Image src="/fortexa-logo.jpeg" alt="Fortexa" width={36} height={36} className="rounded-lg" priority />
          <div>
            <p className="text-sm font-semibold tracking-tight">Fortexa</p>
            <p className="text-[10px] uppercase tracking-widest text-[hsl(var(--muted-foreground))]">Control Room</p>
          </div>
        </Link>

        <nav className="flex-1 space-y-1 px-3 py-4">
          {navItems.map((item) => {
            const active =
              pathname === item.href ||
              (item.href === "/settings" && pathname.startsWith("/settings"));
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  active
                    ? "bg-[hsl(var(--accent)/0.1)] text-[hsl(var(--accent))]"
                    : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted)/0.5)] hover:text-[hsl(var(--foreground))]"
                )}
              >
                {active ? (
                  <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-[hsl(var(--accent))]" />
                ) : null}
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[hsl(var(--border)/0.5)] p-4">
          {wallet ? (
            <div className="mb-3 rounded-xl bg-[hsl(var(--muted)/0.4)] px-3 py-2">
              <p className="truncate font-mono text-xs">{truncateMiddle(wallet, 8, 8)}</p>
              {role ? (
                <p className="text-[10px] uppercase tracking-wider text-[hsl(var(--muted-foreground))]">{role}</p>
              ) : null}
            </div>
          ) : null}
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2" disabled={loggingOut} onClick={logout}>
            {loggingOut ? (
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
            ) : (
              <LogOut aria-hidden="true" className="h-4 w-4" />
            )}
            {loggingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </aside>

      <div className="relative z-10 flex min-h-screen flex-1 flex-col lg:pl-[220px]">
        <header className="app-header sticky top-0 z-30">
          <div className="flex items-center justify-between gap-4 px-4 py-4 md:px-8">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-[hsl(var(--muted-foreground))]">
                Mission Control
              </p>
              <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{pageTitle}</h1>
            </div>
            <div className="flex items-center gap-2">
              <span className="hidden items-center gap-1.5 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.4)] px-3 py-1 text-xs text-[hsl(var(--muted-foreground))] sm:inline-flex">
                <Radio aria-hidden="true" className="h-3 w-3 text-[hsl(var(--accent))]" />
                Stellar Testnet
              </span>
              <SessionChip loading={loading} wallet={wallet} role={role} />
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-6 pb-24 md:px-8 md:py-8 lg:pb-8">{children}</main>
      </div>

      <nav className="app-mobile-nav fixed inset-x-0 bottom-0 z-40 lg:hidden">
        <div className="mx-auto flex max-w-lg items-stretch justify-around px-2 py-2">
          {navItems.map((item) => {
            const active =
              pathname === item.href ||
              (item.href === "/settings" && pathname.startsWith("/settings"));
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex flex-1 flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-medium transition",
                  active ? "text-[hsl(var(--accent))]" : "text-[hsl(var(--muted-foreground))]"
                )}
              >
                <Icon aria-hidden="true" className="h-5 w-5" />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
