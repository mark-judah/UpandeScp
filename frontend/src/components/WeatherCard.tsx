import { useEffect, useState } from "react";
import {
  DropletGlyph,
  GustGlyph,
  WeatherGlyph,
  type WeatherGlyphKind,
} from "@/components/WeatherGlyph";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { call } from "@/lib/frappe";
import { cn } from "@/lib/utils";

interface WeatherDay {
  date: string;
  tempMax: number | null;
  tempMin: number | null;
  precipMm: number | null;
  precipProb: number | null;
  weatherCode: number | null;
  windMax: number | null;
}

interface WeatherPayload {
  farm: string;
  lat?: number;
  lon?: number;
  units?: { temp: string; precip: string; wind: string };
  timezone?: string;
  days: WeatherDay[];
}

// Open-Meteo WMO codes → glyph + short label + colour.
// https://open-meteo.com/en/docs#weathervariables
//
// Colours come from the app's --sd-data-* chart tokens rather than raw Tailwind
// palette values, so the tile themes with the rest of the app (and with dark
// mode) instead of sitting slightly outside it.
export function weatherInfo(code: number | null): {
  kind: WeatherGlyphKind;
  label: string;
  color: string;
} {
  const C = {
    sun: "text-[var(--sd-data-amber)]",
    cloud: "text-[var(--sd-quiet)]",
    rain: "text-[var(--sd-data-cyan)]",
    fog: "text-[var(--sd-data-indigo)]",
    snow: "text-[var(--sd-data-cyan)]",
    storm: "text-[var(--sd-data-violet)]",
  };
  if (code === null || code === undefined)
    return { kind: "unknown", label: "No forecast", color: C.cloud };
  if (code === 0) return { kind: "clear", label: "Clear", color: C.sun };
  if (code <= 2) return { kind: "partly", label: "Mostly sunny", color: C.sun };
  if (code === 3) return { kind: "overcast", label: "Overcast", color: C.cloud };
  if (code === 45 || code === 48)
    return { kind: "fog", label: "Fog", color: C.fog };
  if (code >= 51 && code <= 57)
    return { kind: "drizzle", label: "Drizzle", color: C.rain };
  if (code >= 61 && code <= 67)
    return { kind: "rain", label: "Rain", color: C.rain };
  if (code >= 71 && code <= 77)
    return { kind: "snow", label: "Snow", color: C.snow };
  if (code >= 80 && code <= 82)
    return { kind: "showers", label: "Showers", color: C.rain };
  if (code >= 85 && code <= 86)
    return { kind: "snow", label: "Snow showers", color: C.snow };
  if (code >= 95)
    return { kind: "thunder", label: "Thunderstorm", color: C.storm };
  return { kind: "overcast", label: "Cloudy", color: C.cloud };
}

function dayLabel(iso: string, idx: number): string {
  if (idx === 0) return "Today";
  if (idx === 1) return "Tomorrow";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "short",
  });
}

/**
 * Compact 5-day forecast tile for the chosen farm. Polls
 * ``get_farm_weather`` on every ``farm`` change (cached server-side for
 * 30 min, so rapid switches are cheap) and hides entirely when the
 * farm has no coords on file or upstream is down.
 */
export function WeatherCard({
  farm,
  className,
}: {
  farm: string;
  className?: string;
}) {
  const [data, setData] = useState<WeatherPayload | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!farm) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    call<{ message?: WeatherPayload } | WeatherPayload>(
      "upande_scp.serverscripts.common.weather.get_farm_weather",
      { farm },
    )
      .then((resp) => {
        if (cancelled) return;
        const payload =
          (resp as { message?: WeatherPayload })?.message ??
          (resp as WeatherPayload);
        setData(payload || null);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [farm]);

  if (!farm) return null;
  if (!data?.days?.length && !loading) return null;

  return (
    <Card className={cn("p-3", className)}>
      <CardHeader className="p-0 pb-2 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Weather · {farm}
        </CardTitle>
        {data?.timezone ? (
          <span className="text-[0.65rem] text-muted-foreground">
            {data.timezone}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {loading && !data ? (
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-20 rounded-md bg-muted/40 animate-pulse"
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-2">
            {(data?.days || []).map((d, i) => {
              const { kind, label, color } = weatherInfo(d.weatherCode);
              return (
                <div
                  key={d.date}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border px-1.5 py-2 text-[0.7rem]",
                    // Today reads as the anchor of the row, not a repeat of it.
                    i === 0
                      ? "border-[var(--sd-line)] bg-[var(--sd-bg-soft)]"
                      : "border-[var(--sd-line-soft)] bg-card",
                  )}
                  title={label}
                >
                  <span
                    className={cn(
                      "font-medium",
                      i === 0 ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {dayLabel(d.date, i)}
                  </span>
                  <WeatherGlyph
                    kind={kind}
                    className={cn("h-7 w-7 my-0.5", color)}
                  />
                  <span className="tabular-nums font-semibold">
                    {d.tempMax !== null ? Math.round(d.tempMax) : "—"}°
                    <span className="ml-0.5 font-normal text-muted-foreground">
                      /{d.tempMin !== null ? Math.round(d.tempMin) : "—"}°
                    </span>
                  </span>
                  <span className="text-muted-foreground flex items-center gap-0.5">
                    {d.precipProb !== null && d.precipProb > 0 ? (
                      <>
                        <DropletGlyph className="text-[var(--sd-data-cyan)]" />
                        {d.precipProb}%
                      </>
                    ) : d.windMax !== null && d.windMax > 0 ? (
                      <>
                        <GustGlyph />
                        {Math.round(d.windMax)}
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
