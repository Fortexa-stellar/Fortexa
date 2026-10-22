import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  CheckCircle2,
  Hand,
  OctagonX,
  Shield,
  TriangleAlert,
  Zap,
  Lock,
  Eye,
  Wallet,
} from "lucide-react";

import { PublicPageBackground } from "@/components/public-page-background";
import { Button } from "@/components/ui/button";

const decisions = [
  {
    label: "APPROVE",
    icon: CheckCircle2,
    color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  },
  {
    label: "WARN",
    icon: TriangleAlert,
    color: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  },
  {
    label: "REQUIRE_APPROVAL",
    icon: Hand,
    color: "text-violet-400 border-violet-500/30 bg-violet-500/10",
  },
  { label: "BLOCK", icon: OctagonX, color: "text-rose-400 border-rose-500/30 bg-rose-500/10" },
];

const steps = [
  { icon: Zap, title: "Agent proposes", desc: "Payment intent arrives" },
  { icon: Shield, title: "Policy + risk", desc: "Deterministic evaluation" },
  { icon: Eye, title: "Decision", desc: "Explicit outcome returned" },
  { icon: Wallet, title: "Wallet signs", desc: "Native XDR submission" },
];

export default function LandingPage() {
  return (
    <>
      <PublicPageBackground hueShift={0} speed={0.9} />

      <main className="relative z-10 min-h-screen">
        {/* Hero */}
        <section className="relative mx-auto flex min-h-[90vh] max-w-6xl flex-col items-center justify-start px-6 pb-20 pt-[14vh] text-center md:pt-[18vh]">
          <div className="animate-fade-up mb-6 flex flex-col items-center gap-5">
            <Image
              src="/fortexa-logo.jpeg"
              alt="Fortexa"
              width={72}
              height={72}
              className="rounded-2xl shadow-[0_0_48px_-8px_hsl(var(--accent)/0.45)]"
              priority
            />
            <div className="space-y-3">
              <h1 className="text-6xl font-semibold tracking-tight md:text-8xl">
                <span className="text-gradient">Fortexa</span>
              </h1>
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-[hsl(var(--muted-foreground))] md:text-sm">
                Agentic Payment Firewall on Stellar
              </p>
            </div>
          </div>

          <h2
            className="animate-fade-up max-w-4xl text-4xl font-semibold leading-[1.1] tracking-tight md:text-6xl"
            style={{ animationDelay: "0.1s" }}
          >
            <span className="text-gradient">Safe-by-default</span>
            <br />
            autonomous payments
          </h2>

          <p
            className="animate-fade-up mt-6 max-w-2xl text-lg text-[hsl(var(--muted-foreground))] md:text-xl"
            style={{ animationDelay: "0.2s" }}
          >
            Policy enforcement, risk controls, and human approval gates — before any Stellar
            transaction is signed.
          </p>

          <div
            className="animate-fade-up mt-10 flex flex-wrap items-center justify-center gap-4"
            style={{ animationDelay: "0.3s" }}
          >
            <Link href="/login">
              <Button size="lg" className="gap-2">
                Launch Console <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </Link>
            <Link href="/dashboard">
              <Button variant="outline" size="lg">
                View Dashboard
              </Button>
            </Link>
          </div>

          {/* Decision mock */}
          <div className="animate-fade-up mt-16 w-full max-w-lg" style={{ animationDelay: "0.4s" }}>
            <div className="surface-elevated overflow-hidden p-6 text-left">
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
                  Live evaluation
                </span>
                <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-300">
                  REQUIRE_APPROVAL
                </span>
              </div>
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                Transfer 42 XLM → api.safe-research.ai
              </p>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[hsl(var(--muted))]">
                <div className="h-full w-[34%] rounded-full bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500" />
              </div>
              <p className="mt-2 text-xs text-[hsl(var(--muted-foreground))]">
                Risk score: 34 · Awaiting operator
              </p>
            </div>
          </div>
        </section>

        {/* Decision pills */}
        <section className="mx-auto max-w-5xl px-6 pb-20">
          <div className="flex flex-wrap justify-center gap-3">
            {decisions.map((d) => {
              const Icon = d.icon;
              return (
                <div
                  key={d.label}
                  className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-semibold uppercase tracking-wider ${d.color}`}
                >
                  <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                  {d.label}
                </div>
              );
            })}
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-[hsl(var(--border)/0.5)] bg-[hsl(var(--muted)/0.15)] py-20">
          <div className="mx-auto max-w-5xl px-6">
            <p className="text-center text-xs font-medium uppercase tracking-[0.2em] text-[hsl(var(--accent))]">
              How it works
            </p>
            <h2 className="mt-3 text-center text-3xl font-semibold tracking-tight md:text-4xl">
              Intent to settlement, guarded.
            </h2>
            <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step, i) => {
                const Icon = step.icon;
                return (
                  <div key={step.title} className="relative text-center">
                    {i < steps.length - 1 ? (
                      <div className="absolute left-[calc(50%+28px)] top-6 hidden h-px w-[calc(100%-56px)] bg-[hsl(var(--border))] lg:block" />
                    ) : null}
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.5)]">
                      <Icon aria-hidden="true" className="h-5 w-5 text-[hsl(var(--accent))]" />
                    </div>
                    <p className="font-medium">{step.title}</p>
                    <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{step.desc}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Trust boundary */}
        <section className="py-20">
          <div className="mx-auto max-w-3xl px-6">
            <div className="surface-elevated p-8 md:p-10">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[hsl(var(--accent)/0.3)] bg-[hsl(var(--accent)/0.08)] px-3 py-1 text-xs font-medium text-[hsl(var(--accent))]">
                <Lock aria-hidden="true" className="h-3.5 w-3.5" />
                Wallet-native trust boundary
              </div>
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
                No server-side signing. Ever.
              </h2>
              <p className="mt-4 text-[hsl(var(--muted-foreground))]">
                Fortexa evaluates policy and risk, builds unsigned XDR, and your wallet signs.
                Private keys never leave the client.
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-[hsl(var(--border)/0.5)] py-16">
          <div className="mx-auto max-w-5xl px-6 text-center">
            <h2 className="text-2xl font-semibold md:text-3xl">Ready to govern agent payments?</h2>
            <Link href="/login" className="mt-6 inline-block">
              <Button size="lg" className="gap-2">
                Connect Wallet <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </section>

        <footer className="border-t border-[hsl(var(--border)/0.5)] py-8 text-center text-sm text-[hsl(var(--muted-foreground))]">
          Fortexa · Policy-controlled payment firewall on Stellar
        </footer>
      </main>
    </>
  );
}
