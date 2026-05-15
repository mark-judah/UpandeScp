/**
 * Greenhouse heatmap grid — variation of the in-app upright plot that
 * Application Plan uses for its diagnose step. Mirrors the legacy
 * www/scouting_heatmaps page's per-greenhouse mini-card layout but reads
 * straight from the IDB-cached scouting payload (no separate getHeatmapData
 * round-trips) and colours each plot with the canonical pest / disease
 * colour pulled from the Pest / Plant Disease doctypes.
 *
 * Layout idiom: same `MapHeader` strip + filter row + responsive `grid`
 * of cards used on `ApplicationPlan.tsx`, so the two pages feel like
 * variants of the same widget instead of two unrelated maps.
 */

import { useEffect, useMemo, useState } from "react";
import { Maximize2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useScouting } from "@/hooks/use-scouting";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { UprightHeatmap } from "@/components/UprightHeatmap";
import { ALL, MapHeader, type MapFilterValue } from "./maps/MapHeader";
import { fetchBedsAndZones, DEFAULT_CROP } from "@/lib/scouting-api";
import {
  pestColor,
  diseaseColor,
  useObservationColors,
} from "@/lib/observation-colors";
import { ymd } from "@/lib/utils";
import { flattenZones, type ZoneFeature } from "./maps/zone-utils";
import type { ZoneGeo, ZoneObs } from "./maps/upright-svg";
import type { ScoutingEntry } from "@/lib/scouting-types";

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14);
  return { from: ymd(from), to: ymd(today) };
}

type Mode = "pest" | "disease";

function ghOf(zoneName: string): string {
  const i = zoneName.indexOf(" - Bed ");
  return i >= 0 ? zoneName.slice(0, i) : zoneName.split(" - ")[0];
}

/** One scouting date's contribution to a (greenhouse × pest|disease)
 *  card. The "trend strip" in the modal renders one of these per slot. */
interface DateSlice {
  /** ``date_of_capture`` of the scouting entries that fed this slice. */
  date: string;
  zoneObs: Record<string, ZoneObs>;
  total: number;
  zones: number;
}

interface HeatmapCardData {
  greenhouse: string;
  obsName: string;
  /** Hex from the Pest / Plant Disease doctype (with canonical fallback). */
  color: string;
  /** Per-zone counts aggregated across the whole window — drives the
   *  thumbnail on the card. */
  zoneObs: Record<string, ZoneObs>;
  totalObs: number;
  zonesAffected: number;
  /** Most recent date that contributed to this card (``recent[0].date``
   *  when ``recent`` is non-empty). */
  lastDate: string;
  /** Last 3 *distinct* scouting dates for this (greenhouse, obs), most
   *  recent first. The dates may not be consecutive — the user wants the
   *  three actual scouting events even if a fortnight separates them. */
  recent: DateSlice[];
}

/**
 * Build one heatmap card per (greenhouse × pest|disease). Every card has
 * its own ``zoneObs`` map keyed by the full zone name (e.g.
 * ``Greenhouse X - Bed 3 - Zone 2``). Cards with zero observations are
 * dropped — the legacy page rendered an empty card for those, but a grid
 * full of empties added noise without information.
 */
/** Mutable accumulator the buildCards reducer fills in. Stays internal —
 *  the public surface is ``HeatmapCardData``. */
interface Bucket {
  /** Aggregate zone -> count across every entry that matched the filter. */
  zones: Map<string, number>;
  total: number;
  /** date_of_capture -> (zone -> count). Lets us slice per-date in O(1)
   *  when the modal opens, instead of re-scanning entries. */
  byDate: Map<string, Map<string, number>>;
}

function buildCards(
  entries: ScoutingEntry[],
  mode: Mode,
  obsFilter: Set<string>,
  resolveColor: (name: string) => string,
): HeatmapCardData[] {
  // [greenhouse][obs] → Bucket
  const acc = new Map<string, Map<string, Bucket>>();
  for (const e of entries) {
    const list =
      mode === "pest" ? e.pests_scouting_entry : e.diseases_scouting_entry;
    if (!list || !list.length || !e.zone) continue;
    const gh = ghOf(e.zone);
    if (!gh) continue;
    const date = e.date_of_capture || "";
    for (const row of list as any[]) {
      const name = mode === "pest" ? row.pest : row.disease;
      if (!name) continue;
      if (obsFilter.size && !obsFilter.has(name)) continue;
      let byGh = acc.get(gh);
      if (!byGh) {
        byGh = new Map();
        acc.set(gh, byGh);
      }
      let bucket = byGh.get(name);
      if (!bucket) {
        bucket = { zones: new Map(), total: 0, byDate: new Map() };
        byGh.set(name, bucket);
      }
      const c = Number(row.count) > 0 ? Number(row.count) : 1;
      bucket.zones.set(e.zone, (bucket.zones.get(e.zone) || 0) + c);
      bucket.total += c;
      if (date) {
        let day = bucket.byDate.get(date);
        if (!day) {
          day = new Map();
          bucket.byDate.set(date, day);
        }
        day.set(e.zone, (day.get(e.zone) || 0) + c);
      }
    }
  }

  const cards: HeatmapCardData[] = [];
  acc.forEach((byGh, gh) => {
    byGh.forEach((bucket, obsName) => {
      const color = resolveColor(obsName);
      const zoneObs: Record<string, ZoneObs> = {};
      bucket.zones.forEach((count, zone) => {
        zoneObs[zone] = { count, color };
      });

      // Pick the last 3 distinct scouting dates. ISO YYYY-MM-DD sorts as
      // a string, so a plain descending sort gives us "latest first"
      // without parsing.
      const recent: DateSlice[] = Array.from(bucket.byDate.keys())
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .slice(0, 3)
        .map((date) => {
          const dayMap = bucket.byDate.get(date)!;
          const dayZoneObs: Record<string, ZoneObs> = {};
          let total = 0;
          dayMap.forEach((count, zone) => {
            dayZoneObs[zone] = { count, color };
            total += count;
          });
          return { date, zoneObs: dayZoneObs, total, zones: dayMap.size };
        });

      cards.push({
        greenhouse: gh,
        obsName,
        color,
        zoneObs,
        totalObs: bucket.total,
        zonesAffected: bucket.zones.size,
        lastDate: recent[0]?.date || "",
        recent,
      });
    });
  });

  // Most-active first.
  cards.sort(
    (a, b) =>
      b.totalObs - a.totalObs ||
      a.greenhouse.localeCompare(b.greenhouse) ||
      a.obsName.localeCompare(b.obsName),
  );
  return cards;
}

/** Group zones by greenhouse so the per-card render only walks its own slice.
 *
 *  Geometry is preserved as the already-parsed object — the SVG builder
 *  accepts both strings and parsed FeatureCollections, and skipping the
 *  ``JSON.stringify``/parse round-trip on every card render is the single
 *  biggest contributor to keeping the page from chewing CPU on multi-card
 *  re-paints. */
function indexZonesByGh(zones: ZoneFeature[]): Record<string, ZoneGeo[]> {
  const out: Record<string, ZoneGeo[]> = {};
  for (const z of zones) {
    if (!z.geometry) continue;
    const gh = ghOf(z.zoneName);
    if (!gh) continue;
    if (!out[gh]) out[gh] = [];
    // Cast: the upright-svg parser checks for object vs string.
    out[gh].push({
      name: z.zoneName,
      raw_geojson: z.geometry as unknown as string,
    });
  }
  return out;
}

export function Heatmaps() {
  const [mode, setMode] = useState<Mode>("pest");
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: DEFAULT_CROP,
    farm: ALL,
    greenhouse: ALL,
    ...defaultRange(),
  }));
  const [obsSel, setObsSel] = useState<string>(ALL);
  const [picked, setPicked] = useState<HeatmapCardData | null>(null);

  const { pest, disease } = useObservationColors();
  const resolveColor =
    mode === "pest"
      ? (n: string) => pest(n) || pestColor(n)
      : (n: string) => disease(n) || diseaseColor(n);

  const ghForCall = filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading, progress, weeksLoaded, weeksTotal } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop,
  });

  const [zones, setZones] = useState<ZoneFeature[]>([]);
  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);

  const zonesByGh = useMemo(() => indexZonesByGh(zones), [zones]);

  // Reset obs selection when switching modes — pest options ≠ disease options.
  useEffect(() => {
    setObsSel(ALL);
  }, [mode]);

  // Available obs names within the current data window so the picker only
  // lists what's actually present (instead of every Pest doctype row).
  const obsOptions = useMemo(() => {
    if (!data) return [] as string[];
    const s = new Set<string>();
    for (const e of data.entries) {
      const list = mode === "pest" ? e.pests_scouting_entry : e.diseases_scouting_entry;
      list?.forEach((row: any) => {
        const name = mode === "pest" ? row.pest : row.disease;
        if (name) s.add(name);
      });
    }
    return Array.from(s).sort();
  }, [data, mode]);

  const obsFilter = useMemo(
    () => (obsSel === ALL ? new Set<string>() : new Set([obsSel])),
    [obsSel],
  );

  const cards = useMemo(() => {
    if (!data) return [];
    return buildCards(data.entries, mode, obsFilter, resolveColor);
  }, [data, mode, obsFilter, resolveColor]);

  const farmLower = filters.farm === ALL ? "" : filters.farm.toLowerCase();
  const ghLower =
    filters.greenhouse === ALL ? "" : filters.greenhouse.toLowerCase();
  const visibleCards = useMemo(
    () =>
      cards.filter((c) => {
        if (ghLower && !c.greenhouse.toLowerCase().includes(ghLower))
          return false;
        if (farmLower && !c.greenhouse.toLowerCase().includes(farmLower))
          return false;
        return true;
      }),
    [cards, farmLower, ghLower],
  );

  const totalObs = visibleCards.reduce((s, c) => s + c.totalObs, 0);
  const totalZones = visibleCards.reduce((s, c) => s + c.zonesAffected, 0);
  const distinctGh = new Set(visibleCards.map((c) => c.greenhouse)).size;

  return (
    <div className="flex flex-col min-h-svh">
      <MapHeader
        title="Heatmaps"
        subtitle="Per-greenhouse zone intensity · coloured by pest / disease"
        value={filters}
        onChange={setFilters}
        rightSlot={
          <div className="flex flex-col gap-1 min-w-32">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pest">Pests</SelectItem>
                <SelectItem value="disease">Diseases</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b bg-card/50">
        <div className="flex items-center gap-2">
          <Label htmlFor="hm-obs" className="text-[0.7rem] uppercase">
            {mode === "pest" ? "Pest" : "Disease"}
          </Label>
          <Select value={obsSel} onValueChange={setObsSel}>
            <SelectTrigger id="hm-obs" className="h-8 w-48">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All</SelectItem>
              {obsOptions.map((o) => (
                <SelectItem key={o} value={o}>
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full border"
                      style={{ background: resolveColor(o) }}
                    />
                    {o}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="ml-auto tabular-nums">
          {distinctGh} greenhouses · {totalZones} zones · {totalObs}{" "}
          {mode === "pest" ? "pest" : "disease"}
          {totalObs === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex-1 px-4 md:px-6 py-4 md:py-6">
        {!data || !zones.length ? (
          <Card className="p-12 text-center text-sm text-muted-foreground">
            Loading scouting data and zone geometry…
          </Card>
        ) : visibleCards.length === 0 ? (
          <Card className="p-12 text-center">
            <CardTitle className="text-base">No matching observations</CardTitle>
            <CardDescription className="mt-1">
              Widen the date range or pick a different{" "}
              {mode === "pest" ? "pest" : "disease"}.
            </CardDescription>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {visibleCards.map((c) => {
              const zoneList = zonesByGh[c.greenhouse] || [];
              return (
                <Card
                  key={`${c.greenhouse}::${c.obsName}`}
                  className="p-3 cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setPicked(c)}
                >
                  <CardHeader className="p-0 pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-sm truncate flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full border shrink-0"
                            style={{ background: c.color }}
                            aria-hidden
                          />
                          <span className="truncate">{c.greenhouse}</span>
                        </CardTitle>
                        <CardDescription className="text-[0.7rem] truncate">
                          {c.obsName}
                          {c.lastDate ? ` · ${c.lastDate}` : ""}
                        </CardDescription>
                      </div>
                      <Badge variant="outline" className="tabular-nums shrink-0">
                        {c.totalObs}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    {zoneList.length ? (
                      <UprightHeatmap
                        zones={zoneList}
                        zoneObs={c.zoneObs}
                        width={780}
                        height={300}
                        className="min-h-[260px] [&_svg]:max-h-[320px] [&_svg]:w-full"
                      />
                    ) : (
                      <div className="text-[0.72rem] text-muted-foreground border rounded-md p-3 bg-[var(--sd-bg-soft)]">
                        Zone geometry not available for this greenhouse.
                      </div>
                    )}
                    <div className="mt-2 flex items-center justify-between text-[0.7rem] text-muted-foreground">
                      <span>
                        {c.zonesAffected} affected zone
                        {c.zonesAffected === 1 ? "" : "s"}
                      </span>
                      <span className="inline-flex items-center gap-1 opacity-70">
                        <Maximize2 className="h-3 w-3" />
                        Expand
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Expanded modal — three trend strips for the last 3 distinct
          scouting events (not the last 3 calendar days). Reads straight
          from the IDB-cached entries that already drive the page; no
          extra fetches. */}
      <Dialog open={!!picked} onOpenChange={(o) => !o && setPicked(null)}>
        <DialogContent className="max-w-[min(98vw,1600px)] max-h-[92vh] overflow-y-auto">
          {picked && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <span
                    className="h-3 w-3 rounded-full border shrink-0"
                    style={{ background: picked.color }}
                    aria-hidden
                  />
                  {picked.greenhouse} · {picked.obsName}
                </DialogTitle>
                <DialogDescription>
                  {picked.totalObs} observation
                  {picked.totalObs === 1 ? "" : "s"} across{" "}
                  {picked.zonesAffected} zone
                  {picked.zonesAffected === 1 ? "" : "s"} · last 3 scouting
                  dates shown left-to-right (most recent first)
                </DialogDescription>
              </DialogHeader>

              {picked.recent.length === 0 ? (
                <div className="text-sm text-muted-foreground p-6 text-center border rounded-md bg-[var(--sd-bg-soft)]">
                  No dated scouting entries to plot.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[0, 1, 2].map((i) => {
                    const slice = picked.recent[i];
                    const labels = [
                      "Latest scouting",
                      "2nd latest scouting",
                      "3rd latest scouting",
                    ];
                    return (
                      <div
                        key={i}
                        className="flex flex-col gap-2 border rounded-md p-2 bg-card"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[0.7rem] uppercase tracking-wide font-semibold text-muted-foreground">
                            {labels[i]}
                          </span>
                          {slice ? (
                            <Badge
                              variant="outline"
                              className="tabular-nums shrink-0"
                            >
                              {slice.total}
                            </Badge>
                          ) : (
                            <span className="text-[0.7rem] text-muted-foreground">
                              —
                            </span>
                          )}
                        </div>
                        {slice ? (
                          <>
                            <div className="text-xs font-medium tabular-nums">
                              {slice.date}
                            </div>
                            <UprightHeatmap
                              zones={zonesByGh[picked.greenhouse] || []}
                              zoneObs={slice.zoneObs}
                              width={1200}
                              height={520}
                              className="min-h-[420px] [&_svg]:max-h-[520px] [&_svg]:w-full"
                            />
                            <div className="text-[0.7rem] text-muted-foreground">
                              {slice.zones} affected zone
                              {slice.zones === 1 ? "" : "s"}
                            </div>
                          </>
                        ) : (
                          <div className="flex-1 flex items-center justify-center min-h-[260px] text-[0.72rem] text-muted-foreground border-dashed border rounded-md bg-[var(--sd-bg-soft)]">
                            No earlier scouting recorded
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Trend hint: how the count moved across the 3 dates. */}
              {picked.recent.length > 1 && (
                <div className="flex flex-wrap items-center gap-3 text-[0.72rem] text-muted-foreground border-t pt-2">
                  <span className="font-medium text-foreground">Trend</span>
                  {picked.recent
                    .slice()
                    .reverse()
                    .map((s, i, arr) => {
                      const prev = i > 0 ? arr[i - 1].total : null;
                      const delta =
                        prev != null ? s.total - prev : null;
                      return (
                        <span
                          key={s.date}
                          className="inline-flex items-center gap-1.5 tabular-nums"
                        >
                          <span className="text-muted-foreground">
                            {s.date}
                          </span>
                          <span className="font-semibold text-foreground">
                            {s.total}
                          </span>
                          {delta != null && delta !== 0 && (
                            <span
                              className={
                                delta > 0
                                  ? "text-[var(--sd-data-red)]"
                                  : "text-[var(--sd-data-green)]"
                              }
                            >
                              ({delta > 0 ? "+" : ""}
                              {delta})
                            </span>
                          )}
                        </span>
                      );
                    })}
                </div>
              )}

              <div className="flex items-center gap-2 text-[0.7rem] text-muted-foreground border-t pt-2">
                <span>Intensity</span>
                {[0.2, 0.4, 0.6, 0.8, 1].map((op) => (
                  <span
                    key={op}
                    className="h-2.5 w-6 rounded border"
                    style={{ background: picked.color, opacity: op }}
                  />
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto h-7"
                  onClick={() => setPicked(null)}
                >
                  Close
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <LoadingOverlay
        open={loading}
        progress={progress}
        weeksLoaded={weeksLoaded}
        weeksTotal={weeksTotal}
      />
    </div>
  );
}
