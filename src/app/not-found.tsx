import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, Compass, ShieldAlert } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";

export const metadata = {
  title: "404 - Page Not Found | Fortexa",
  description: "The requested page could not be found.",
};

/**
 * Branded Not Found (404) page for Fortexa.
 *
 * Implements safe navigation back to public home or authenticated console
 * without echoing unvalidated user paths or parameters into the DOM,
 * protecting against reflection and DOM-XSS attacks.
 */
export default function NotFound() {
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
          <span className="text-xl font-bold tracking-tight text-white">Fortexa</span>
        </div>

        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-rose-500/30 bg-rose-500/10 text-rose-400">
          <ShieldAlert className="h-8 w-8" aria-hidden="true" />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-semibold tracking-wider text-rose-400 uppercase">
            Error 404
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Page Not Found
          </h1>
          <p className="text-sm text-neutral-400">
            The requested page does not exist, has been relocated, or is unavailable under the current policy.
          </p>
        </div>

        <div className="flex w-full flex-col gap-3 pt-2 sm:flex-row">
          <Link
            href="/"
            aria-label="Return to Fortexa homepage"
            className={cn(buttonVariants({ variant: "outline" }), "flex-1 gap-2 border-white/10 text-white hover:bg-white/10")}
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Home</span>
          </Link>
          <Link
            href="/console"
            aria-label="Go to Fortexa decision and payment console"
            className={cn(buttonVariants(), "flex-1 gap-2 bg-emerald-500 text-black hover:bg-emerald-400 font-medium")}
          >
            <Compass className="h-4 w-4" />
            <span>Console</span>
          </Link>
        </div>
      </div>
    </main>
  );
}
