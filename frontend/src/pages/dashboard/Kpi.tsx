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
    <Card
      className={cn(
        // Reference .kpi: roomy padding, soft shadow (from Card), and a
        // hover-lift so the metric tiles feel alive. No cursor-pointer —
        // these aren't clickable in this app.
        "relative flex flex-col overflow-hidden p-6 transition-all duration-200",
        "hover:-translate-y-[3px] hover:shadow-[var(--sd-shadow-2)]",
        className,
      )}
    >
      {/* .kpi__label — 11px, uppercase, wide tracking */}
      <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--sd-quiet)] pr-8">
        {label}
      </div>
      {/* .kpi__value — hero 44px number, tight tracking, tabular */}
      <div
        className={cn(
          "text-[36px] md:text-[44px] font-semibold leading-none tracking-[-0.03em] tabular-nums",
          TONE[tone],
        )}
      >
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-[13px] text-[var(--sd-quiet)] line-clamp-2">
          {hint}
        </div>
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
        "grid gap-4",
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
