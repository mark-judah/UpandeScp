import { useState } from "react";
import { cn } from "@/lib/utils";

export interface SeriesPoint { week: string; date?: string; value: number }
export type KpiSeries = Record<string, SeriesPoint[]>;
export interface KpiSeriesPayload { series: KpiSeries }

/** Fewer points than this is not a trend: the line is drawn faint. */
export const MIN_TREND_POINTS = 3;

const W = 84;
const H = 26;
const PAD = 3;

/**
 * Tiny inline-SVG trend for a KPI card: thin monochrome line, end dot, no axes
 * or gridlines. Pinned to the card's top-right corner. Hover shows the week and
 * value. Muted (faint) when there are fewer than MIN_TREND_POINTS points.
 */
export function Sparkline({ points, className }: { points?: SeriesPoint[]; className?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points || points.length === 0) return null;

  const muted = points.length < MIN_TREND_POINTS;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const n = points.length;
  const xy = points.map((p, i) => ({
    x: n === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (n - 1),
    y: hi === lo ? H / 2 : H - PAD - ((p.value - lo) / span) * (H - PAD * 2),
  }));
  const path = xy.map((q, i) => `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ");
  const end = xy[n - 1];
  const hp = hover === null ? null : points[hover];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / (r.width || W)) * W;
    let best = 0;
    xy.forEach((q, i) => { if (Math.abs(q.x - x) < Math.abs(xy[best].x - x)) best = i; });
    setHover(best);
  };

  return (
    <div
      data-testid="kpi-sparkline"
      data-muted={muted ? "true" : "false"}
      className={cn(
        "kpi-sparkline absolute right-4 top-4 text-[var(--sd-quiet)]",
        muted ? "opacity-30" : "opacity-70 hover:opacity-100",
        "transition-opacity",
        className,
      )}
    >
      <svg
        width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        role="img" aria-label="Trend by week"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.25}
              strokeLinejoin="round" strokeLinecap="round" />
        {n > 1 && <circle data-testid="spark-dot" cx={end.x} cy={end.y} r={1.9} fill="currentColor" />}
        {hover !== null && (
          <circle cx={xy[hover].x} cy={xy[hover].y} r={2.4} fill="currentColor" />
        )}
      </svg>
      {hp && (
        <div
          role="tooltip"
          className="pointer-events-none absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded-md bg-[var(--sd-ink)] px-2 py-1 text-[11px] text-white shadow-md"
        >
          {hp.week}: {hp.value.toLocaleString("en-US")}
        </div>
      )}
    </div>
  );
}
