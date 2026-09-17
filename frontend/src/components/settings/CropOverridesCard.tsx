/**
 * Settings → Spray Plan → what this crop does differently.
 *
 * Roses are sprayed inside greenhouses, avocado is an exposed orchard, coffee
 * is a third thing again — so a handful of the spray-plan knobs genuinely
 * differ by crop while most do not. Three independent copies of the whole set
 * would be three things to keep in step; a crop that cannot differ at all is
 * wrong for the wind speed that stops spraying an orchard.
 *
 * So each row here shows the site default and lets this crop replace it.
 * **Empty means inherit.** There is no "use default" switch to get out of step
 * with the value beside it: clearing the box is how you go back, and the row
 * then shows what it fell back to. That is also exactly what the server stores
 * — no row for a setting the crop does not override — so what is on screen and
 * what is in the database say the same thing.
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/errors";
import {
  fetchCropSettings,
  saveCropSettings,
  type CropSettings,
} from "@/lib/settings-api";

/** Human labels for the overridable fieldnames. The server sends the reason a
 *  field is overridable; the name it goes by is the page's business. */
const LABELS: Record<string, string> = {
  weather_wind_green_max_kmh: "Wind — green up to (km/h)",
  weather_wind_red_min_kmh: "Wind — red from (km/h)",
  weather_rain_green_max_pct: "Rain probability — green up to (%)",
  weather_rain_red_min_pct: "Rain probability — red from (%)",
  weather_temp_green_min_c: "Temperature — green from (°C)",
  weather_temp_green_max_c: "Temperature — green up to (°C)",
  weather_temp_red_max_c: "Temperature — red from (°C)",
  weather_temp_red_min_c: "Temperature — red below (°C)",
  irac_rotation_window_days: "IRAC rotation window (days)",
  frac_rotation_window_days: "FRAC rotation window (days)",
  spray_cutoff_time: "Daily spray cutoff",
  postponement_max_days: "Furthest a plan may be pushed (days)",
  postponement_grace_minutes: "Grace after cutoff (minutes)",
  auto_cancel_enabled: "Auto-cancel dormant plans (1 or 0)",
  auto_cancel_dormant_days: "Dormant window (days)",
  csu_scan_verification: "CSU scan verification",
};

/** The order they read in — weather together, then rotation, then the day's
 *  shape — rather than whatever order the object happens to iterate in. */
const GROUPS: Array<{ title: string; keys: string[] }> = [
  {
    title: "Weather limits",
    keys: [
      "weather_wind_green_max_kmh",
      "weather_wind_red_min_kmh",
      "weather_rain_green_max_pct",
      "weather_rain_red_min_pct",
      "weather_temp_green_min_c",
      "weather_temp_green_max_c",
      "weather_temp_red_max_c",
      "weather_temp_red_min_c",
    ],
  },
  {
    title: "Resistance rotation",
    keys: ["irac_rotation_window_days", "frac_rotation_window_days"],
  },
  {
    title: "The spray day",
    keys: [
      "spray_cutoff_time",
      "postponement_max_days",
      "postponement_grace_minutes",
    ],
  },
  {
    title: "Dormant plans",
    keys: ["auto_cancel_enabled", "auto_cancel_dormant_days"],
  },
  { title: "Store handover", keys: ["csu_scan_verification"] },
];

export function CropOverridesCard({ crop }: { crop: string }) {
  const [data, setData] = useState<CropSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!crop) return;
    setLoading(true);
    setError(null);
    fetchCropSettings(crop)
      .then((d) => {
        setData(d);
        // Only overridden keys start with a value. Everything else is blank,
        // which IS the inherit state — not a placeholder for one.
        const next: Record<string, string> = {};
        for (const key of d.overridden) next[key] = String(d.effective[key] ?? "");
        setDraft(next);
      })
      .catch((e) => setError(errorText(e, "Could not load this crop's settings.")))
      .finally(() => setLoading(false));
  }, [crop]);

  const overriddenNow = useMemo(
    () => Object.entries(draft).filter(([, v]) => String(v).trim() !== "").length,
    [draft],
  );
  const total = useMemo(
    () => Object.keys(data?.overridable || {}).length,
    [data],
  );

  const dirty = useMemo(() => {
    if (!data) return false;
    const was = new Set(data.overridden);
    const now = new Set(
      Object.entries(draft)
        .filter(([, v]) => String(v).trim() !== "")
        .map(([k]) => k),
    );
    if (was.size !== now.size) return true;
    for (const k of now) {
      if (!was.has(k)) return true;
      if (String(draft[k]).trim() !== String(data.effective[k] ?? "")) return true;
    }
    return false;
  }, [data, draft]);

  async function save() {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(draft)) {
        if (String(v).trim() !== "") values[k] = String(v).trim();
      }
      await saveCropSettings(crop, values);
      const fresh = await fetchCropSettings(crop);
      setData(fresh);
      const next: Record<string, string> = {};
      for (const key of fresh.overridden) next[key] = String(fresh.effective[key] ?? "");
      setDraft(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(errorText(e, "Could not save this crop's settings."));
    } finally {
      setBusy(false);
    }
  }

  if (!crop) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          What {crop} does differently
          <span className="rounded-full bg-muted px-2 py-0.5 text-[0.7rem] font-medium tabular-nums text-muted-foreground">
            {overriddenNow} of {total} overridden
          </span>
        </CardTitle>
        <CardDescription>
          Leave a box empty to use the site default shown beside it. Anything you
          type here applies to {crop} only — every other crop keeps the default.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading {crop}'s settings…
          </div>
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : data ? (
          <>
            {GROUPS.map((group) => {
              const keys = group.keys.filter((k) => k in (data.overridable || {}));
              if (!keys.length) return null;
              return (
                <div key={group.title} className="space-y-2">
                  <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                    {group.title}
                  </div>
                  {keys.map((key) => {
                    const isOverridden = String(draft[key] ?? "").trim() !== "";
                    return (
                      <div
                        key={key}
                        className="grid grid-cols-1 gap-1 sm:grid-cols-[1fr_170px] sm:items-center"
                      >
                        <div className="min-w-0">
                          <Label htmlFor={`ov-${key}`} className="text-xs">
                            {LABELS[key] || key}
                          </Label>
                          <div className="truncate text-[0.7rem] text-muted-foreground">
                            {isOverridden ? (
                              <>
                                Site default {String(data.defaults[key] ?? "—")} —{" "}
                                <span className="font-medium text-foreground">
                                  overridden
                                </span>
                              </>
                            ) : (
                              <>Inherits {String(data.defaults[key] ?? "—")}</>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Input
                            id={`ov-${key}`}
                            className="h-8 text-xs"
                            value={draft[key] ?? ""}
                            placeholder={String(data.defaults[key] ?? "")}
                            title={data.overridable[key]}
                            onChange={(e) =>
                              setDraft((d) => ({ ...d, [key]: e.target.value }))
                            }
                          />
                          {isOverridden ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 shrink-0"
                              title={`Go back to the site default (${String(
                                data.defaults[key] ?? "",
                              )})`}
                              onClick={() =>
                                setDraft((d) => {
                                  const n = { ...d };
                                  delete n[key];
                                  return n;
                                })
                              }
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                          ) : (
                            <span className="h-8 w-8 shrink-0" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}

            <div className="flex items-center gap-2 pt-1">
              <Button size="sm" onClick={save} disabled={busy || !dirty}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save {crop} settings
              </Button>
              {saved ? (
                <span className="text-xs text-muted-foreground">Saved.</span>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
