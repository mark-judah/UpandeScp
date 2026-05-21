import { useEffect, useState } from "react";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  Sun,
  Wind,
  type LucideIcon,
} from "lucide-react";
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

// Open-Meteo WMO codes → icon + short label.
// https://open-meteo.com/en/docs#weathervariables
function weatherInfo(code: number | null): { icon: LucideIcon; label: string } {
  if (code === null || code === undefined)
    return { icon: Cloud, label: "—" };
  if (code === 0) return { icon: Sun, label: "Clear" };
  if (code <= 2) return { icon: Sun, label: "Mostly sunny" };
  if (code === 3) return { icon: Cloud, label: "Overcast" };
  if (code === 45 || code === 48) return { icon: CloudFog, label: "Fog" };
  if (code >= 51 && code <= 57) return { icon: CloudDrizzle, label: "Drizzle" };
  if (code >= 61 && code <= 67) return { icon: CloudRain, label: "Rain" };
  if (code >= 71 && code <= 77) return { icon: CloudSnow, label: "Snow" };
  if (code >= 80 && code <= 82) return { icon: CloudRain, label: "Showers" };
  if (code >= 85 && code <= 86) return { icon: CloudSnow, label: "Snow showers" };
  if (code >= 95) return { icon: CloudLightning, label: "Thunderstorm" };
  return { icon: Cloud, label: "Cloudy" };
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
      "upande_scp.serverscripts.weather.get_farm_weather",
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

  const tempUnit = data?.units?.temp || "°C";

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
              const { icon: Icon, label } = weatherInfo(d.weatherCode);
              return (
                <div
                  key={d.date}
                  className="flex flex-col items-center gap-1 rounded-md border bg-card px-1.5 py-2 text-[0.7rem]"
                  title={label}
                >
                  <span className="font-medium text-muted-foreground">
                    {dayLabel(d.date, i)}
                  </span>
                  <Icon className="h-5 w-5 text-foreground" />
                  <span className="tabular-nums font-semibold">
                    {d.tempMax !== null ? Math.round(d.tempMax) : "—"}°
                    <span className="ml-0.5 font-normal text-muted-foreground">
                      /{d.tempMin !== null ? Math.round(d.tempMin) : "—"}°
                    </span>
                  </span>
                  <span className="text-muted-foreground flex items-center gap-0.5">
                    {d.precipProb !== null && d.precipProb > 0 ? (
                      <>
                        <CloudRain className="h-2.5 w-2.5" />
                        {d.precipProb}%
                      </>
                    ) : d.windMax !== null && d.windMax > 0 ? (
                      <>
                        <Wind className="h-2.5 w-2.5" />
                        {Math.round(d.windMax)}
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-2 text-[0.6rem] text-muted-foreground/60 text-right">
          Source: Open-Meteo · temp in {tempUnit}
        </div>
      </CardContent>
    </Card>
  );
}
