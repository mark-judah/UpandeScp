/**
 * Spray-window weather for a plan (Approvals), and the condensation-risk card.
 *
 * The window is the plan's planned time to +4 h (settings): temperature,
 * relative humidity, rain, wind and gusts, with WARN-ONLY flags for rain, wind,
 * high humidity and air near its dew point. Nothing here blocks an approval.
 * Plans past the forecast horizon read "Forecast not available yet"; a plan
 * submitted earlier also shows the window as it was forecast at submit.
 */
import { useEffect, useMemo, useState } from "react";
import { CloudRain, Droplets, Thermometer, TriangleAlert, Wind } from "lucide-react";
import { call } from "@/lib/frappe";
import { cn } from "@/lib/utils";

export interface WindowFlag {
  kind: "rain" | "wind" | "humidity" | "dew";
  text: string;
}

export interface WindowWeather {
  status: "ok" | "unavailable";
  reason?: string;
  message?: string;
  past?: boolean;
  window?: { start: string; end: string; hours: number };
  tempMin?: number | null;
  tempMax?: number | null;
  humidityAvg?: number | null;
  humidityMax?: number | null;
  precipMm?: number | null;
  precipProb?: number | null;
  windMax?: number | null;
  gustMax?: number | null;
  dewSpreadMin?: number | null;
  flags?: WindowFlag[];
  taken_at?: string;
}

export interface WindowItem {
  /** your own key: the work order, or a farm heading */
  key: string;
  farm: string;
  /** planned date-time, "YYYY-MM-DD HH:MM:SS" */
  start: string;
  /** a work order whose submit-time snapshot should come back too */
  wo?: string;
}

interface WindowRow {
  key: string;
  weather: WindowWeather;
  snapshot?: WindowWeather | null;
}

/** Window weather for many plans in ONE request (the server shares a fetch per farm and day). */
export function useWindowWeather(items: WindowItem[]): Record<string, WindowRow> {
  const sig = useMemo(
    () => JSON.stringify(items.filter((i) => i.farm && i.start).map((i) => [i.key, i.farm, i.start, i.wo || ""])),
    [items],
  );
  const [rows, setRows] = useState<Record<string, WindowRow>>({});
  useEffect(() => {
    const list = JSON.parse(sig) as [string, string, string, string][];
    if (!list.length) {
      setRows({});
      return;
    }
    let off = false;
    call<WindowRow[] | { message: WindowRow[] }>("upande_scp.serverscripts.common.weather_window.get_window_weather", {
      items: JSON.stringify(list.map(([key, farm, start, wo]) => ({ key, farm, start, wo: wo || undefined }))),
    })
      .then((r) => {
        if (off) return;
        const arr = (Array.isArray(r) ? r : (r as { message: WindowRow[] })?.message) || [];
        setRows(Object.fromEntries(arr.map((x) => [x.key, x])));
      })
      .catch(() => !off && setRows({}));
    return () => {
      off = true;
    };
  }, [sig]);
  return rows;
}

const n = (v: number | null | undefined, d = 0) => (v == null ? "—" : v.toFixed(d));

const FLAG_ICON = { rain: CloudRain, wind: Wind, humidity: Droplets, dew: Droplets } as const;

/** One compact line (two when a submit-time snapshot exists). */
export function WindowWeatherChip({
  weather,
  snapshot,
  className,
}: {
  weather?: WindowWeather;
  snapshot?: WindowWeather | null;
  className?: string;
}) {
  if (!weather) return null;
  if (weather.status !== "ok") {
    return (
      <div className={cn("text-[0.65rem] text-muted-foreground", className)} data-testid="wx-unavailable">
        {weather.message || "Weather n/a"}
      </div>
    );
  }
  const flags = weather.flags || [];
  return (
    <div className={cn("flex flex-col gap-0.5 text-[0.65rem] text-muted-foreground", className)} data-testid="wx-window">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums">
        <span className="inline-flex items-center gap-0.5" title="Temperature in the spray window">
          <Thermometer className="h-3 w-3" />
          {weather.tempMin === weather.tempMax ? n(weather.tempMax) : `${n(weather.tempMin)}–${n(weather.tempMax)}`}°C
        </span>
        <span title="Relative humidity (highest in the window)">RH {n(weather.humidityMax)}%</span>
        <span title="Rain probability / amount">
          Rain {weather.precipProb == null ? "—" : `${weather.precipProb}%`}
          {weather.precipMm ? ` · ${n(weather.precipMm, 1)} mm` : ""}
        </span>
        <span title="Wind (gusts)">
          Wind {n(weather.windMax)} ({n(weather.gustMax)}) km/h
        </span>
        <span title="Smallest gap between air temperature and dew point">Dew gap {n(weather.dewSpreadMin, 1)}°C</span>
      </div>
      {flags.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="wx-flags">
          {flags.map((f) => {
            const Icon = FLAG_ICON[f.kind] || TriangleAlert;
            return (
              <span
                key={f.kind}
                title={f.text}
                className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-px font-medium text-amber-700 dark:text-amber-400"
              >
                <Icon className="h-3 w-3" />
                {f.text.split(" (")[0]}
              </span>
            );
          })}
        </div>
      )}
      {snapshot?.status === "ok" && (
        <div data-testid="wx-snapshot" className="tabular-nums">
          At submit: {n(snapshot.tempMin)}–{n(snapshot.tempMax)}°C · RH {n(snapshot.humidityMax)}% · rain{" "}
          {snapshot.precipProb == null ? "—" : `${snapshot.precipProb}%`} · wind {n(snapshot.windMax)} km/h
        </div>
      )}
    </div>
  );
}

// ── Condensation risk card ──────────────────────────────────────────────────

export interface CondensationAlertRow {
  name: string;
  greenhouse: string;
  farm?: string;
  alert_date: string;
  hours: number;
  min_spread: number;
  max_humidity: number;
  last_seen?: string;
}

const short = (g: string) => g.replace(/\s+-\s+[A-Z]{1,4}$/, "");

/** Today's condensation-risk alerts (scout for downy mildew). Renders nothing when there are none. */
export function CondensationAlerts({ farms, className }: { farms?: string[]; className?: string }) {
  const [rows, setRows] = useState<CondensationAlertRow[]>([]);
  const key = (farms || []).join(",");
  useEffect(() => {
    let off = false;
    call<CondensationAlertRow[] | { message: CondensationAlertRow[] }>(
      "upande_scp.serverscripts.common.condensation.get_condensation_alerts",
      { farms: key || undefined, days: 1 },
    )
      .then((r) => {
        if (!off) setRows((Array.isArray(r) ? r : (r as { message: CondensationAlertRow[] })?.message) || []);
      })
      .catch(() => !off && setRows([]));
    return () => {
      off = true;
    };
  }, [key]);
  if (!rows.length) return null;
  return (
    <div
      role="status"
      data-testid="condensation-alerts"
      className={cn("rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200", className)}
    >
      <div className="flex items-center gap-1.5 font-semibold">
        <Droplets className="h-3.5 w-3.5" />
        Condensation risk: scout for downy mildew
      </div>
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map((r) => (
          <li key={r.name} className="tabular-nums">
            {short(r.greenhouse)} · {r.hours.toFixed(1)} h within {r.min_spread.toFixed(1)}°C of dew point · RH up to{" "}
            {Math.round(r.max_humidity)}%
          </li>
        ))}
      </ul>
    </div>
  );
}
