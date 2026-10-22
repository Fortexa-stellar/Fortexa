import { Loader2 } from "lucide-react";

export default function ConsoleLoading() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="surface-elevated flex items-center justify-center gap-3 py-24">
        <Loader2 className="h-5 w-5 animate-spin text-[hsl(var(--accent))]" />
        <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading console…</p>
      </div>
    </div>
  );
}
