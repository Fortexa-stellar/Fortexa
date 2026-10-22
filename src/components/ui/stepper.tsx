import { cn } from "@/lib/utils/cn";
import { Check } from "lucide-react";

type Step = {
  id: number;
  label: string;
};

export function Stepper({
  steps,
  currentStep,
  className,
}: {
  steps: Step[];
  currentStep: number;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {steps.map((step, index) => {
        const isComplete = currentStep > step.id;
        const isActive = currentStep === step.id;

        return (
          <div key={step.id} className="flex flex-1 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-all duration-300",
                  isComplete &&
                    "border-[hsl(var(--accent))] bg-[hsl(var(--accent))] text-[hsl(var(--primary-foreground))]",
                  isActive &&
                    "border-[hsl(var(--accent))] bg-[hsl(var(--accent)/0.15)] text-[hsl(var(--accent))] shadow-[0_0_20px_rgba(34,211,238,0.25)]",
                  !isComplete &&
                    !isActive &&
                    "border-[hsl(var(--border))] bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]"
                )}
              >
                {isComplete ? <Check className="h-4 w-4" /> : step.id}
              </div>
              <span
                className={cn(
                  "hidden truncate text-[11px] font-medium uppercase tracking-wider sm:block",
                  isActive ? "text-[hsl(var(--accent))]" : "text-[hsl(var(--muted-foreground))]"
                )}
              >
                {step.label}
              </span>
            </div>
            {index < steps.length - 1 ? (
              <div
                className={cn(
                  "mb-5 h-px flex-1 transition-colors duration-300",
                  isComplete ? "bg-[hsl(var(--accent)/0.5)]" : "bg-[hsl(var(--border))]"
                )}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
