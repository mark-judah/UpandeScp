/**
 * Previous ~5 ISO weeks of weather for a farm.
 *
 * Distinct from WeatherCard, which forecasts ("should we spray tomorrow"). This
 * looks BACKWARDS, bucketed into the same ISO weeks the scouting data uses, so
 * a pest trend can be read against the conditions that preceded it.
 *
 * Week-on-week change is the headline, not the absolute total: "rain up 16mm on
 * last week" is what explains a spike, where "18.5mm" alone doesn't.
 */

import { useEffect, useState } from "react";
import { call } from "@/lib/frappe";
import { cn } from "@/lib/utils";
import { DropletGlyph } from "@/components/WeatherGlyph";

export interface WeatherWeek {
  week: string;
  precipMm: number;
  tempMean: number | null;
  humidity: number | null;
  windMean: number | null;
  days: number;
  partial: boolean;
  precipDelta: number | null;
  tempDelta: number | null;
  humidityDelta: number | null;
}

export function useWeatherHistory(
  farm: string,
  fromDate?: string,
  toDate?: string,
): WeatherWeek[] | null {
  const [weeks, setWeeks] = useState<WeatherWeek[] | null>(null);
  useEffect(() => {
    if (!farm) {
      setWeeks(null);
      return;
    }
    let cancelled = false;
    call<{ weeks: WeatherWeek[] }>(
      "upande_scp.serverscripts.common.weather.get_farm_weather_history",
      { farm, from_date: fromDate, to_date: toDate },
    )
      .then((r) => {
        if (!cancelled) setWeeks(r?.weeks ?? []);
      })
      .catch(() => {
        if (!cancelled) setWeeks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [farm, fromDate, toDate]);
  return weeks;
}

/** ISO week label → a comparable integer, so gaps in the shown weeks can be
 *  detected. "2026-W29" → 202629. */
export function weekOrdinal(week: string): number {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(week || "");
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/** True when every week shown is consecutive.
 *
 *  Matters because a continuous line across non-consecutive weeks would imply
 *  readings for weeks that aren't plotted. When false the caption says so. */
export function weeksAreConsecutive(weeks: string[]): boolean {
  for (let i = 1; i < weeks.length; i++) {
    const a = weekOrdinal(weeks[i - 1]);
    const b = weekOrdinal(weeks[i]);
    if (!a || !b) return false;
    // Same year → +1; year rollover → week 1 after 52/53.
    const sameYear = Math.floor(a / 100) === Math.floor(b / 100);
    if (sameYear ? b - a !== 1 : b % 100 !== 1) return false;
  }
  return true;
}

/** Smooth SVG path through evenly-spaced points (Catmull-Rom → cubic bezier).
 *
 *  Tension is kept low so the curve doesn't overshoot below zero on a rainfall
 *  series — a dip under the axis would imply negative rain. */
export function smoothPath(values: number[], w: number, h: number, pad = 2): string {
  const n = values.length;
  if (!n) return "";
  const max = Math.max(...values, 1);
  const x = (i: number) => pad + (i / Math.max(1, n - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  if (n === 1) return `M${x(0)},${y(values[0])}L${w - pad},${y(values[0])}`;

  const pts = values.map((v, i) => [x(i), y(v)] as [number, number]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const t = 0.5 / 3;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += `C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** "+16.0" / "−3.1" / "—". Unicode minus so columns align in tabular-nums. */
export function fmtDelta(v: number | null, unit = ""): string {
  if (v === null || v === undefined) return "—";
  if (v === 0) return `0${unit}`;
  return `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}${unit}`;
}

/** A rise in rain or humidity generally precedes pressure, so those read as the
 *  "worse" direction. Temperature is left neutral — its effect is pest-specific
 *  and signing it would assert a relationship we haven't established. */
function deltaTone(v: number | null): string {
  if (v === null || v === 0) return "text-muted-foreground";
  return v > 0
    ? "text-[var(--sd-data-cyan)]"
    : "text-muted-foreground";
}

export function WeatherHistory({
  farm,
  className,
  highlightWeek,
  fromDate,
  toDate,
  onlyWeeks,
}: {
  farm: string;
  className?: string;
  /** ISO week to emphasise — kept in step with the terrain's current frame. */
  highlightWeek?: string;
  /** Range to fetch. Should be the period the greenhouse was actually scouted,
   *  not a trailing window from today. */
  fromDate?: string;
  toDate?: string;
  /** Restrict to exactly these ISO weeks (the scouted weeks). */
  onlyWeeks?: string[];
}) {
  const all = useWeatherHistory(farm, fromDate, toDate);
  if (!farm || !all?.length) return null;

  const weeks = onlyWeeks?.length
    ? all.filter((w) => onlyWeeks.includes(w.week))
    : all;
  if (!weeks.length) return null;

  const W = 200;
  const H = 34;
  const rain = weeks.map((w) => w.precipMm);
  const path = smoothPath(rain, W, H);
  const maxRain = Math.max(...rain, 1);
  const contiguous = weeksAreConsecutive(weeks.map((w) => w.week));
  const px = (i: number) => 2 + (i / Math.max(1, weeks.length - 1)) * (W - 4);
  const py = (v: number) => H - 2 - (v / maxRain) * (H - 4);
  const hiIdx = weeks.findIndex((w) => w.week === highlightWeek);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline gap-2">
        <span className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
          Rainfall · weeks scouted
        </span>
        <span className="ml-auto text-[0.6rem] tabular-nums text-muted-foreground">
          peak {maxRain.toFixed(1)}mm
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[34px] w-full"
        preserveAspectRatio="none"
      >
        <path
          d={path}
          fill="none"
          stroke="var(--sd-data-cyan)"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          // Dashed when the weeks aren't consecutive: a solid line across a gap
          // would imply readings for weeks that aren't plotted.
          strokeDasharray={contiguous ? undefined : "3 2"}
        />
        {weeks.map((w, i) => (
          <circle
            key={w.week}
            cx={px(i)}
            cy={py(w.precipMm)}
            r={i === hiIdx ? 2.6 : 1.6}
            fill={
              i === hiIdx ? "var(--sd-ink)" : "var(--sd-data-cyan)"
            }
          />
        ))}
      </svg>

      <div className="flex justify-between">
        {weeks.map((w) => (
          <span
            key={w.week}
            className={cn(
              "text-[0.6rem] tabular-nums",
              w.week === highlightWeek
                ? "font-semibold text-foreground"
                : "text-muted-foreground",
            )}
            title={
              `${w.week}${w.partial ? ` (partial — ${w.days} days)` : ""}\n` +
              `Rain ${w.precipMm}mm (${fmtDelta(w.precipDelta, "mm")} on prev)\n` +
              `Temp ${w.tempMean ?? "—"}°C (${fmtDelta(w.tempDelta, "°")})\n` +
              `Humidity ${w.humidity ?? "—"}% (${fmtDelta(w.humidityDelta, "%")})`
            }
          >
            W{w.week.slice(-2)}
            {w.partial ? "*" : ""}
          </span>
        ))}
      </div>

      <p className="text-[0.6rem] leading-snug text-muted-foreground">
        Weekly rainfall for the weeks this greenhouse was scouted. Hover a week
        for temperature, humidity and the change on the week before.
        {contiguous ? "" : " Dashed — the weeks shown are not consecutive."}
      </p>
    </div>
  );
}
