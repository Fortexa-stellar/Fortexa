import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  className,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "surface-elevated p-5 transition hover:border-[hsl(var(--accent)/0.2)]",
        className
      )}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-[hsl(var(--muted-foreground))]">
          {label}
        </p>
        {Icon ? <Icon aria-hidden="true" className="h-4 w-4 text-[hsl(var(--accent))]" /> : null}
      </div>
      <p className="text-2xl font-semibold tracking-tight">{value}</p>
      {sub ? <p className="mt-2 text-sm text-[hsl(var(--muted-foreground))]">{sub}</p> : null}
    </div>
  );
}
