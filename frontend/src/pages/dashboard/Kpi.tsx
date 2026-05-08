import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface KpiProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "warning" | "critical" | "good";
  className?: string;
}

const TONE: Record<NonNullable<KpiProps["tone"]>, string> = {
  default: "text-foreground",
  warning: "text-[var(--sd-target)]",
  critical: "text-[var(--sd-data-red)]",
  good: "text-[var(--sd-data-green)]",
};

export function Kpi({ label, value, hint, tone = "default", className }: KpiProps) {
  return (
    <Card className={cn("p-4 flex flex-col gap-1", className)}>
      <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold leading-tight tracking-tight tabular-nums",
          TONE[tone],
        )}
      >
        {value}
      </div>
      {hint && (
        <div className="text-xs text-muted-foreground line-clamp-2">{hint}</div>
      )}
    </Card>
  );
}

export function KpiGrid({
  children,
  cols = 4,
  className,
}: {
  children: React.ReactNode;
  cols?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-3",
        cols === 4 && "grid-cols-2 lg:grid-cols-4",
        cols === 3 && "grid-cols-1 sm:grid-cols-3",
        cols === 2 && "grid-cols-1 sm:grid-cols-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
