"use client";

import { useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

/**
 * Application error boundary for Fortexa.
 *
 * Implements a minimal error boundary with retry navigation, optional request ID,
 * and strict suppression of raw exception text or stack traces to prevent
 * sensitive internal state disclosure.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log error to console for debugging while preventing UI leak
    console.error("Application error boundary caught error:", error);
  }, [error]);

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center">
      <div className="relative z-10 mx-auto flex max-w-md flex-col items-center gap-6 rounded-2xl border border-white/10 bg-black/60 p-8 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <Image
            src="/fortexa-logo.jpeg"
            alt="Fortexa"
            width={48}
            height={48}
            className="rounded-xl shadow-[0_0_24px_-4px_hsl(var(--accent)/0.35)]"
          />
          <span className="text-xl font-bold tracking-tight text-white">
            Fortexa
          </span>
        </div>

        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
          <AlertTriangle className="h-8 w-8" aria-hidden="true" />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-semibold tracking-wider text-amber-400 uppercase">
            Application Error
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Something went wrong
          </h1>
          <p className="text-sm text-neutral-400">
            An unexpected error occurred while loading this page. You can retry
            the action or return to the dashboard.
          </p>

          {error?.digest ? (
            <p className="rounded-lg bg-white/5 px-3 py-1.5 font-mono text-xs text-neutral-400">
              Request ID:{" "}
              <span className="text-neutral-200">{error.digest}</span>
            </p>
          ) : null}
        </div>

        <div className="flex w-full flex-col gap-3 pt-2 sm:flex-row">
          <Button
            onClick={() => reset()}
            variant="default"
            className="flex-1 gap-2 bg-[hsl(var(--accent))] text-[hsl(var(--primary-foreground))] hover:brightness-110 font-medium"
          >
            <RotateCcw className="h-4 w-4" />
            <span>Try Again</span>
          </Button>
          <Link
            href="/dashboard"
            aria-label="Return to Dashboard"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "flex-1 gap-2 border-white/10 text-white hover:bg-white/10"
            )}
          >
            <Home className="h-4 w-4" />
            <span>Dashboard</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
