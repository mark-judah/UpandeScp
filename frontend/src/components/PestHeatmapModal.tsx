/**
 * The 3D heatmap of ONE pest or disease in ONE greenhouse, for a decision.
 *
 * Opened from a spray plan's target pill so a general manager can see whether
 * the pest is really there before approving the spend. Landscape: the 3D
 * terrain (the Heatmaps page's own Terrain3D, fed by the same `heatmap_terrain`
 * endpoint) on the left, and a side panel on the right with the week pills, the
 * station-prevalence figure, its weekly trend and the threshold band from
 * `get_pest_heatmap_summary` — so the modal judges the pest with the same bands
 * as the dashboard alerts and nothing needs scrolling.
 *
 * Reusable: give it a greenhouse, an observation, a crop and (optionally) the
 * date the window ends on. Escape and the close button dismiss it.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReliabilityPill } from "@/pages/dashboard/PrevalenceFigure";
import { projectGeometry, type ProjectedGeometry, type ZoneGeoLike } from "@/pages/maps/bed-projection";
import { flattenZones } from "@/pages/maps/zone-utils";
import type { TerrainWeekData } from "@/pages/maps/Terrain3D";
import { METHOD } from "@/hooks/use-dashboard-aggregate";
import { call } from "@/lib/frappe";
import { fetchBedsAndZones } from "@/lib/scouting-api";
import { figureLine, type PrevalenceFigures } from "@/lib/prevalence";
import { errorText } from "@/lib/errors";
import { cn, ymd } from "@/lib/utils";

// three.js is heavy: load it only when a heatmap is actually opened.
const Terrain3D = lazy(() =>
  import("@/pages/maps/Terrain3D").then((m) => ({ default: m.Terrain3D })),
);

export const SUMMARY_METHOD =
  "upande_scp.serverscripts.spray_plan_ops.pest_heatmap_summary.get_pest_heatmap_summary";

export type ObsKind = "pest" | "disease";

export interface PestHeatmapModalProps {
  /** Greenhouse (warehouse) name; null/"" keeps the modal closed. */
  greenhouse: string | null;
  /** The pest or disease name; null/"" keeps the modal closed. */
  observation: string | null;
  /** Omit when unknown: the server looks the name up. */
  kind?: ObsKind;
  crop: string;
  /** Last day of the window (YYYY-MM-DD); default today. */
  toDate?: string;
  /** Weeks to look back at first: 1, 2 (default) or 4. */
  defaultWeeks?: number;
  onClose: () => void;
}

interface SeriesPoint {
  week: string;
  value: number | null;
  band: "low" | "moderate" | "high" | null;
}

interface Summary {
  obsKind: ObsKind;
  measure: "Percentage" | "Count";
  threshold: { low: number; moderate: number; high: number; measure: string } | null;
  latest: (PrevalenceFigures & { value: number | null; band: string | null }) | null;
  series: SeriesPoint[];
}

export const WEEK_OPTIONS = ["1", "2", "4"];
const weekLabel = (n: string) => `${n} week${n === "1" ? "" : "s"}`;
const BAND_TONE: Record<string, string> = {
  high: "var(--sd-data-red)",
  moderate: "var(--sd-data-amber)",
  low: "var(--sd-data-green)",
};

function ghOf(zoneName: string): string {
  const i = zoneName.indexOf(" - Bed ");
  return i >= 0 ? zoneName.slice(0, i) : zoneName.split(" - ")[0];
}

function windowFor(toDate: string | undefined, weeks: number) {
  const end = toDate ? new Date(`${toDate}T00:00:00`) : new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - 7 * weeks + 1);
  return { from: ymd(start), to: ymd(end) };
}

/** The house's projected bed geometry, fetched through the cached zones call. */
function useHouseGeometry(greenhouse: string | null): ProjectedGeometry | null {
  const [geom, setGeom] = useState<ProjectedGeometry | null>(null);
  useEffect(() => {
    setGeom(null);
    if (!greenhouse) return;
    let live = true;
    fetchBedsAndZones()
      .then((vs) => {
        if (!live) return;
        const zones: ZoneGeoLike[] = flattenZones(vs)
          .filter((z) => z.geometry && ghOf(z.zoneName) === greenhouse)
          .map((z) => ({ name: z.zoneName, raw_geojson: z.geometry as unknown as string }));
        setGeom(zones.length ? projectGeometry(zones) : null);
      })
      .catch(() => live && setGeom(null));
    return () => {
      live = false;
    };
  }, [greenhouse]);
  return geom;
}

export function PestHeatmapModal({
  greenhouse,
  observation,
  kind,
  crop,
  toDate,
  defaultWeeks = 2,
  onClose,
}: PestHeatmapModalProps) {
  const open = !!greenhouse && !!observation;
  const [weeks, setWeeks] = useState(String(defaultWeeks));
  // A specific scouted week, picked from the pills; null = every week in range.
  const [onlyWeek, setOnlyWeek] = useState<string | null>(null);
  useEffect(() => {
    setWeeks(String(defaultWeeks));
    setOnlyWeek(null);
  }, [greenhouse, observation, defaultWeeks]);
  const n = Number(weeks) || 2;
  const range = useMemo(() => windowFor(toDate, n), [toDate, n]);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [terrain, setTerrain] = useState<TerrainWeekData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const geometry = useHouseGeometry(open ? greenhouse : null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setSummary(null);
    setTerrain(null);
    setError(null);
    call<Summary>(SUMMARY_METHOD, {
      greenhouse, obs_name: observation, obs_kind: kind ?? "", crop, weeks: n, to_date: range.to,
    })
      .then((s) => {
        if (!live) return;
        setSummary(s);
        // Same endpoint and arguments as the Heatmaps page's 3D view.
        return call<{ weeks: TerrainWeekData[] }>(METHOD.heatmap_terrain, {
          from_date: range.from, to_date: range.to, crop, greenhouse,
          obs_name: observation, obs_kind: kind ?? s?.obsKind ?? "pest",
        }).then((r) => live && setTerrain(r?.weeks ?? []));
      })
      .catch((e) => {
        if (!live) return;
        setError(errorText(e, "Could not load the heatmap."));
        setTerrain((prev) => prev ?? []);
      });
    return () => {
      live = false;
    };
  }, [open, greenhouse, observation, kind, crop, n, range.from, range.to]);

  const resolvedKind: ObsKind = kind ?? summary?.obsKind ?? "pest";
  const loading = open && terrain === null && !error;
  const weekLabels = (terrain ?? []).map((w) => w.date);
  const shown = useMemo(
    () => (terrain ?? []).filter((w) => !onlyWeek || w.date === onlyWeek),
    [terrain, onlyWeek],
  );
  const positions = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(geometry?.zoneCentroids ?? {}).map(([zone, c]) => [zone, { x: c.cx, y: c.cy }]),
      ),
    [geometry],
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="flex h-[70vh] max-h-[90vh] w-[90vw] max-w-none flex-col gap-3 p-4 sm:max-w-none sm:p-5"
        data-testid="pest-heatmap-modal"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">{observation} · {greenhouse}</DialogTitle>
          <DialogDescription>
            {range.from} → {range.to} · {resolvedKind}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <div className="relative min-h-[240px] min-w-0 flex-1" data-testid="heatmap-3d">
            {loading ? (
              <div className="h-full min-h-[240px] animate-pulse rounded-md bg-[var(--sd-bg-soft)]" aria-hidden data-skeleton="map" />
            ) : terrain && terrain.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-md border bg-[var(--sd-bg-soft)] p-6 text-center text-sm text-muted-foreground">
                No scouting of {observation} in {greenhouse} between {range.from} and {range.to}.
              </div>
            ) : (
              <Suspense fallback={<div className="h-full min-h-[240px] animate-pulse rounded-md bg-[var(--sd-bg-soft)]" aria-hidden />}>
                <Terrain3D weeks={shown} positions={positions} className="h-full min-h-[240px]" />
              </Suspense>
            )}
          </div>

          <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto md:w-80" data-testid="heatmap-side">
            <div className="flex flex-col gap-1.5">
              <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
                Weeks of scouting
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Weeks to show">
                {WEEK_OPTIONS.map((w) => (
                  <WeekPill
                    key={w}
                    active={!onlyWeek && weeks === w}
                    onClick={() => { setWeeks(w); setOnlyWeek(null); }}
                  >
                    {weekLabel(w)}
                  </WeekPill>
                ))}
              </div>
              {weekLabels.length > 0 ? (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Specific week">
                  {weekLabels.map((w) => (
                    <WeekPill key={w} active={onlyWeek === w} onClick={() => setOnlyWeek(onlyWeek === w ? null : w)}>
                      {w.replace(/^\d{4}-/, "")}
                    </WeekPill>
                  ))}
                </div>
              ) : null}
              {error ? <span role="alert" className="text-xs text-[var(--sd-data-red)]">{error}</span> : null}
            </div>
            <SummaryBlock summary={summary} loading={loading && !summary} />
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WeekPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[0.7rem] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        active ? "border-foreground bg-foreground text-background" : "bg-background hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function SummaryBlock({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  if (loading) {
    return <div className="h-14 animate-pulse rounded-md bg-[var(--sd-bg-soft)]" aria-hidden data-skeleton="summary" />;
  }
  if (!summary) return null;
  const { latest, threshold, series } = summary;
  const unit = summary.measure === "Count" ? " per station" : "%";
  return (
    <div className="flex flex-col gap-3" data-testid="heatmap-summary">
      <div className="flex flex-col gap-1.5 rounded-md border bg-card p-3 text-xs">
        <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Latest scouted week
        </div>
        {latest ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold tabular-nums">
                {latest.value ?? "—"}
                {latest.value != null ? unit : ""}
              </span>
              <ReliabilityPill value={latest.reliability} />
              {latest.band ? (
                <span
                  data-testid="band-pill"
                  className="rounded-full px-1.5 py-px text-[0.6rem] font-medium capitalize leading-none"
                  style={{
                    color: BAND_TONE[latest.band],
                    background: `color-mix(in srgb, ${BAND_TONE[latest.band]} 14%, transparent)`,
                  }}
                >
                  {latest.band} band
                </span>
              ) : null}
            </div>
            <div className="text-muted-foreground">{figureLine(latest)}</div>
          </>
        ) : (
          <div className="text-muted-foreground">No scouted stations in this window.</div>
        )}
        <div className="text-muted-foreground">
          {threshold
            ? `Bands: low ${threshold.low} · moderate ${threshold.moderate} · high ${threshold.high}${unit}`
            : "No threshold bands set for this pest."}
        </div>
      </div>
      <TrendBars series={series} threshold={threshold} unit={unit} />
    </div>
  );
}

/** Weekly bars with the moderate / high bands as dashed rules. Hand-drawn SVG:
 *  a handful of bars does not need a chart library. */
function TrendBars({
  series, threshold, unit,
}: { series: SeriesPoint[]; threshold: Summary["threshold"]; unit: string }) {
  const W = 260, H = 90, PAD = 14;
  const values = series.map((s) => s.value ?? 0);
  const top = Math.max(1, ...values, threshold?.high ?? 0, threshold?.moderate ?? 0) * 1.1;
  const y = (v: number) => H - PAD - (v / top) * (H - PAD * 2);
  const bw = series.length ? Math.min(34, (W - 20) / series.length - 8) : 0;
  return (
    <div className="flex flex-col gap-1 rounded-md border bg-card p-3">
      <div className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
        Trend · last {series.length || 0} scouted week{series.length === 1 ? "" : "s"}
      </div>
      {series.length === 0 ? (
        <div className="text-xs text-muted-foreground">No weekly figures.</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly trend" className="w-full" data-testid="heatmap-trend">
          {threshold?.moderate ? (
            <line x1="0" x2={W} y1={y(threshold.moderate)} y2={y(threshold.moderate)}
              stroke="var(--sd-data-amber)" strokeDasharray="3 3" strokeWidth="1" />
          ) : null}
          {threshold?.high ? (
            <line x1="0" x2={W} y1={y(threshold.high)} y2={y(threshold.high)}
              stroke="var(--sd-data-red)" strokeDasharray="3 3" strokeWidth="1" />
          ) : null}
          {series.map((s, i) => {
            const x = 10 + i * ((W - 20) / series.length) + 4;
            const v = s.value ?? 0;
            return (
              <g key={s.week}>
                <rect x={x} y={y(v)} width={bw} height={Math.max(1, H - PAD - y(v))} rx="2"
                  fill={s.band ? BAND_TONE[s.band] : "var(--sd-muted)"} opacity="0.85" />
                <text x={x + bw / 2} y={y(v) - 2} textAnchor="middle" fontSize="8" fill="currentColor">
                  {s.value ?? "–"}
                </text>
                <text x={x + bw / 2} y={H - 3} textAnchor="middle" fontSize="7" fill="var(--sd-muted)">
                  {s.week.replace(/^\d{4}-/, "")}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="text-[0.65rem] text-muted-foreground">Figures in {unit.trim() || "%"} · dashed: moderate, high</div>
    </div>
  );
}
