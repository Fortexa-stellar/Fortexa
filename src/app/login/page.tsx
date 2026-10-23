import { Suspense } from "react";
import Link from "next/link";
import { LoginForm } from "@/components/login-form";
import { PublicPageBackground } from "@/components/public-page-background";
import Image from "next/image";
import { Shield, Lock, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

export default function LoginPage() {
  return (
    <>
      <PublicPageBackground hueShift={0} speed={0.9} />

      <main className="relative z-10 flex min-h-screen items-center justify-center px-6 py-12">
        <div className="relative grid w-full max-w-4xl gap-12 lg:grid-cols-2 lg:items-center">
          <section className="space-y-6">
            <Link
              href="/"
              className="inline-flex items-center gap-3 transition-opacity hover:opacity-80"
            >
              <Image
                src="/fortexa-logo.jpeg"
                alt="Fortexa"
                width={48}
                height={48}
                className="rounded-xl"
                priority
              />
              <div>
                <p className="text-lg font-semibold">Fortexa</p>
                <p className="text-xs uppercase tracking-widest text-[hsl(var(--muted-foreground))]">
                  Control Room
                </p>
              </div>
            </Link>

            <h1 className="text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              Sign in with your Stellar wallet
            </h1>

            <p className="max-w-md text-[hsl(var(--muted-foreground))]">
              Session identity binds to your wallet. Operators run evaluations and payments; viewers
              get read-only access.
            </p>

            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] p-4">
                <Shield className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--accent))]" />
                <div className="text-sm">
                  <p className="font-medium">Wallet-bound sessions</p>
                  <p className="text-[hsl(var(--muted-foreground))]">
                    Freighter connects once; no password flows.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.3)] p-4">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--accent))]" />
                <div className="text-sm">
                  <p className="font-medium">Zero custody</p>
                  <p className="text-[hsl(var(--muted-foreground))]">
                    Signing stays in your wallet extension.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section>
            <Suspense
              fallback={
                <Card className="border-[hsl(var(--accent)/0.15)]">
                  <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-[hsl(var(--muted-foreground))]">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading...
                  </CardContent>
                </Card>
              }
            >
              <LoginForm />
            </Suspense>
          </section>
        </div>
      </main>
    </>
  );
}
