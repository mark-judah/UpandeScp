import { Card } from "@/components/ui/card";
import { KpiValueSkeleton, TextSkeleton } from "@/components/Loading";
import { cn } from "@/lib/utils";
import { Sparkline, seriesDelta, type SeriesPoint } from "./Sparkline";

export interface KpiProps {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "warning" | "critical" | "good";
  className?: string;
  /** First load: the label stays, the figure and hint are placeholders. */
  loading?: boolean;
  /** Weekly values for the top-right sparkline; omit for no trend. */
  series?: SeriesPoint[];
  /** Which direction is good news; tints the delta pill. Neutral when omitted. */
  goodDirection?: "up" | "down";
}

const TONE: Record<NonNullable<KpiProps["tone"]>, string> = {
  default: "text-foreground",
  warning: "text-[var(--sd-target)]",
  critical: "text-[var(--sd-data-red)]",
  good: "text-[var(--sd-data-green)]",
};

export function Kpi({ label, value, hint, tone = "default", className, loading = false, series, goodDirection }: KpiProps) {
  const delta = loading ? null : seriesDelta(series);
  // Thousands separators for large counts (e.g. 648361 → 648,361).
  const display =
    typeof value === "number" ? value.toLocaleString("en-US") : value;
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
      {!loading && <Sparkline points={series} />}
      {/* .kpi__label — 11px, uppercase, wide tracking */}
      <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--sd-quiet)] pr-24">
        {label}
      </div>
      {/* .kpi__value — hero 44px number, tight tracking, tabular */}
      {loading ? (
        <KpiValueSkeleton className="h-[36px] md:h-[44px] w-20" />
      ) : (
        <div
          className={cn(
            "text-[36px] md:text-[44px] font-semibold leading-none tracking-[-0.03em] tabular-nums",
            TONE[tone],
          )}
        >
          {display}
        </div>
      )}
      {loading ? (
        <div className="mt-2 text-[13px] leading-5">
          <TextSkeleton width="10ch" />
        </div>
      ) : hint && (
        <div className="mt-2 text-[13px] text-[var(--sd-quiet)] line-clamp-2">
          {hint}
        </div>
      )}
      {delta && <DeltaPill delta={delta} goodDirection={goodDirection} />}
    </Card>
  );
}

function DeltaPill({ delta, goodDirection }: { delta: NonNullable<ReturnType<typeof seriesDelta>>; goodDirection?: "up" | "down" }) {
  const good = delta.dir === "flat" || !goodDirection ? null : delta.dir === goodDirection;
  const arrow = delta.dir === "up" ? "\u2191" : delta.dir === "down" ? "\u2193" : "\u2192";
  const amount = delta.pct === null
    ? Math.abs(delta.abs).toLocaleString("en-US")
    : `${Math.abs(delta.pct).toFixed(delta.pct !== 0 && Math.abs(delta.pct) < 10 ? 1 : 0)}%`;
  return (
    <div
      data-testid="kpi-delta"
      data-dir={delta.dir}
      className={cn(
        "mt-4 inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium tabular-nums",
        good === null && "bg-[var(--sd-ink)]/[0.05] text-[var(--sd-quiet)]",
        good === true && "bg-[var(--sd-data-green)]/12 text-[var(--sd-data-green)]",
        good === false && "bg-[var(--sd-data-red)]/10 text-[var(--sd-data-red)]",
      )}
    >
      {arrow} {delta.dir === "flat" ? "0%" : amount}
      <small className="font-medium opacity-65">vs prev week</small>
    </div>
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
