import { useId, useState } from "react";
import { cn } from "@/lib/utils";

export interface SeriesPoint { week: string; date?: string; value: number }
export type KpiSeries = Record<string, SeriesPoint[]>;
export interface KpiSeriesPayload { series: KpiSeries }

/** Fewer points than this is not a trend: the line is drawn faint. */
export const MIN_TREND_POINTS = 3;

const W = 58;
const H = 26;
const PAD = 3;

export interface SeriesDelta { dir: "up" | "down" | "flat"; pct: number | null; abs: number }

/** Change of the latest point against the one before it (null with < 2 points). */
export function seriesDelta(points?: SeriesPoint[]): SeriesDelta | null {
  if (!points || points.length < 2) return null;
  const cur = points[points.length - 1].value;
  const prev = points[points.length - 2].value;
  const abs = cur - prev;
  return { dir: abs > 0 ? "up" : abs < 0 ? "down" : "flat", pct: prev === 0 ? null : (abs / Math.abs(prev)) * 100, abs };
}

/**
 * Tiny inline-SVG trend for a KPI card, after the UFD reference cards: a smooth
 * 2px bezier line with a quiet-to-ink gradient and round caps, 58x26, no axes,
 * fill or gridlines, plus an end dot. Pinned to the card's top-right corner. Hover shows the week and
 * value. Muted (faint) when there are fewer than MIN_TREND_POINTS points.
 */
export function Sparkline({ points, className }: { points?: SeriesPoint[]; className?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const gid = `spark-${useId().replace(/:/g, "")}`;
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
  // Smooth cubic through the points (horizontal tangents at each, like the reference).
  const path = xy
    .map((q, i) => {
      if (i === 0) return `M${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      const p = xy[i - 1];
      const mx = ((p.x + q.x) / 2).toFixed(1);
      return `C${mx} ${p.y.toFixed(1)} ${mx} ${q.y.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    })
    .join(" ");
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
        "kpi-sparkline absolute right-4 top-5 text-[var(--sd-ink)]",
        muted ? "opacity-30" : "opacity-90",
        "transition-opacity",
        className,
      )}
    >
      <svg
        width={W} height={H} viewBox={`0 0 ${W} ${H}`}
        role="img" aria-label="Trend by week"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--sd-quiet)" />
            <stop offset="100%" stopColor="var(--sd-ink)" />
          </linearGradient>
        </defs>
        <path d={path} fill="none" stroke={`url(#${gid})`} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" />
        {n > 1 && <circle data-testid="spark-dot" cx={end.x} cy={end.y} r={2.2} fill="var(--sd-ink)" />}
        {hover !== null && (
          <circle cx={xy[hover].x} cy={xy[hover].y} r={2.8} fill="var(--sd-ink)" />
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
