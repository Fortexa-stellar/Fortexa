import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function Alert({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-[hsl(var(--border)/0.95)] bg-[hsl(var(--muted)/0.5)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]",
        className
      )}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h4 className={cn("text-sm font-semibold", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn("mt-1 text-sm text-[hsl(var(--muted-foreground))]", className)} {...props} />
  );
}
