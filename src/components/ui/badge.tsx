import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-[0.12em] uppercase",
  {
    variants: {
      variant: {
        default:
          "border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.7)] text-[hsl(var(--foreground))]",
        approve: "border-emerald-400/30 bg-emerald-500/20 text-emerald-200",
        warn: "border-amber-400/35 bg-amber-500/20 text-amber-200",
        require: "border-violet-400/35 bg-violet-500/20 text-violet-200",
        block: "border-rose-400/35 bg-rose-500/20 text-rose-200",
        info: "border-cyan-400/35 bg-cyan-500/20 text-cyan-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
