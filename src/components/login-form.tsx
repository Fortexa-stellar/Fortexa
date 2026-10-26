"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExternalLink, Loader2, Wallet } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loginWithFreighter, type LoginWithFreighterStep } from "@/lib/auth/freighter";
import { truncateMiddle } from "@/lib/utils/format";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/dashboard";

  const [loading, setLoading] = useState(false);
  const [loginStep, setLoginStep] = useState<LoginWithFreighterStep | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successWallet, setSuccessWallet] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as { authenticated?: boolean };
        if (!cancelled && payload.authenticated) {
          router.replace(nextPath.startsWith("/") ? nextPath : "/dashboard");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCheckingSession(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [router, nextPath]);

  async function handleSignIn() {
    setLoading(true);
    setError(null);
    setSuccessWallet(null);
    setLoginStep("connecting");

    const result = await loginWithFreighter({
      onStep: (step) => setLoginStep(step),
    });

    if (!result.ok) {
      setError(
        result.retryAfterSeconds
          ? `${result.message} Try again in ${result.retryAfterSeconds}s.`
          : result.message
      );
      setLoading(false);
      setLoginStep(null);
      return;
    }

    setSuccessWallet(result.wallet);
    const destination = nextPath.startsWith("/") ? nextPath : "/dashboard";
    window.location.assign(destination);
  }

  function loginStepLabel(step: LoginWithFreighterStep | null) {
    switch (step) {
      case "connecting":
        return "Connecting wallet...";
      case "challenge":
        return "Preparing login challenge...";
      case "signing":
        return "Sign message in Freighter...";
      case "verifying":
        return "Verifying signature...";
      default:
        return "Waiting for Freighter...";
    }
  }

  if (checkingSession) {
    return (
      <Card className="border-[hsl(var(--accent)/0.15)]">
        <CardContent className="flex items-center justify-center gap-2 py-16 text-sm text-[hsl(var(--muted-foreground))]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking session...
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-[hsl(var(--accent)/0.15)]">
      <CardHeader>
        <CardDescription>Wallet access</CardDescription>
        <CardTitle className="text-2xl">Sign in with Freighter</CardTitle>
        <CardDescription>
          Connect your Stellar wallet, sign a one-time login challenge, and start a secure session. No passwords.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={handleSignIn} disabled={loading} className="h-12 w-full gap-2 text-base">
          {loading ? (
            <>
              <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
              {successWallet ? "Opening console..." : loginStepLabel(loginStep)}
            </>
          ) : (
            <>
              <Wallet aria-hidden="true" className="h-5 w-5" />
              Sign in with Freighter
            </>
          )}
        </Button>

        {successWallet ? (
          <p className="text-center font-mono text-xs text-[hsl(var(--muted-foreground))]">
            {truncateMiddle(successWallet, 10, 10)} · redirecting
          </p>
        ) : null}

        {error ? (
          <Alert className="border-rose-500/25 bg-rose-500/8">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <p className="text-center text-xs text-[hsl(var(--muted-foreground))]">
          Need Freighter?{" "}
          <a
            href="https://www.freighter.app/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[hsl(var(--accent))] hover:underline"
          >
            Get extension <ExternalLink aria-hidden="true" className="h-3 w-3" />
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
