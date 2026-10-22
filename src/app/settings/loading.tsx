import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex gap-1 border-b border-[hsl(var(--border))]">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-9 flex-1 rounded-none rounded-t-lg sm:flex-initial sm:w-28"
          />
        ))}
      </div>

      <div className="surface-elevated flex items-center justify-center gap-3 py-24">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[hsl(var(--muted-foreground)/0.3)] border-t-[hsl(var(--accent))]" />
        <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading settings…</p>
      </div>
    </div>
  );
}
