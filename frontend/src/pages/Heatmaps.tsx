/**
 * Heatmaps grid — bed-line plots with instanced observation markers.
 *
 * Data: ``upande_scp.serverscripts.dashboard_aggregates.heatmaps_grid``
 *       returns every (greenhouse × pest|disease) card matching the
 *       filter row, with each card carrying the 3 most-recent scouting
 *       dates and per-zone counts.
 *
 * Render: ``BedSvg`` draws one prerendered SVG path per bed + an
 *         instanced marker shape (from ``MarkerDefs``) at each observed
 *         zone's centroid. Card thumbnails show the latest date; the
 *         click-to-expand modal lays out the 3 dates side-by-side.
 *
 * Bed geometry comes from the long-cached ``fetchBedsAndZones`` payload;
 * each greenhouse is projected once via ``projectGeometry`` and the
 * result is memoised so cards for the same greenhouse share the math.
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
import {
  useDashboardAggregate,
} from "@/hooks/use-dashboard-aggregate";
import { ALL, MapHeader, type MapFilterValue } from "./maps/MapHeader";
import { fetchBedsAndZones, DEFAULT_CROP } from "@/lib/scouting-api";
import { flattenZones, type ZoneFeature } from "./maps/zone-utils";
import { ymd } from "@/lib/utils";
import { ProgressOverlay } from "./dashboard/ProgressOverlay";
import { MarkerDefs, type MarkerKind } from "./maps/MarkerDefs";
import { BedSvg, type BedMarker } from "./maps/BedSvg";
import {
  projectGeometry,
  type ProjectedGeometry,
  type ZoneGeoLike,
} from "./maps/bed-projection";

type Mode = "pest" | "disease";

function ghOf(zoneName: string): string {
  const i = zoneName.indexOf(" - Bed ");
  return i >= 0 ? zoneName.slice(0, i) : zoneName.split(" - ")[0];
}

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14);
  return { from: ymd(from), to: ymd(today) };
}

interface HeatmapCard {
  greenhouse: string;
  obsName: string;
  obsKind: "pest" | "disease";
  color: string;
  totalObs: number;
  zonesAffected: number;
  lastDate: string;
  recent: Array<{ date: string; zoneObs: Record<string, number> }>;
}

interface HeatmapsGridPayload {
  cards: HeatmapCard[];
}

/** Group raw zone features by greenhouse so each card only walks its
 *  own slice. Memoised once at page load — geometry rarely changes. */
function indexZonesByGh(zones: ZoneFeature[]): Record<string, ZoneGeoLike[]> {
  const out: Record<string, ZoneGeoLike[]> = {};
  for (const z of zones) {
    if (!z.geometry) continue;
    const gh = ghOf(z.zoneName);
    if (!gh) continue;
    if (!out[gh]) out[gh] = [];
    out[gh].push({
      name: z.zoneName,
      raw_geojson: z.geometry as unknown as string,
    });
  }
  return out;
}

/** Lazy per-greenhouse projection. The first card to need a greenhouse
 *  pays the ~80 ms cost; every later card for the same greenhouse hits
 *  the memo. */
function useProjectedGeometries(
  zonesByGh: Record<string, ZoneGeoLike[]>,
  needed: string[],
): Record<string, ProjectedGeometry | null> {
  const [cache, setCache] = useState<Record<string, ProjectedGeometry | null>>(
    {},
  );
  useEffect(() => {
    const missing = needed.filter((gh) => !(gh in cache) && zonesByGh[gh]);
    if (!missing.length) return;
    // Project synchronously; ~80 ms each, so a chunk of work but it's
    // the only price we pay for not running this server-side.
    const next: Record<string, ProjectedGeometry | null> = { ...cache };
    for (const gh of missing) {
      next[gh] = projectGeometry(zonesByGh[gh]);
    }
    setCache(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed.join("|"), zonesByGh]);
  return cache;
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
  const [picked, setPicked] = useState<HeatmapCard | null>(null);

  // Reset obs picker when mode flips — pest list ≠ disease list.
  useEffect(() => setObsSel(ALL), [mode]);

  // Aggregate fetch — one server call returns every applicable card.
  const aggFilters = {
    from_date: filters.from,
    to_date:   filters.to,
    crop:      filters.crop === DEFAULT_CROP ? "" : filters.crop,
    farm:      filters.farm === ALL ? "" : filters.farm,
    greenhouse: filters.greenhouse === ALL ? "" : filters.greenhouse,
    mode,
    observation: obsSel === ALL ? "" : obsSel,
  };
  const gridState = useDashboardAggregate<HeatmapsGridPayload>(
    "heatmaps_grid",
    aggFilters,
    true,
  );
  const cards = gridState.data?.cards ?? [];

  // Geometry — fetched once, projected per-greenhouse on demand.
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);
  const zonesByGh = useMemo(() => indexZonesByGh(zones), [zones]);
  const neededGhs = useMemo(
    () => Array.from(new Set(cards.map((c) => c.greenhouse))),
    [cards],
  );
  const geometryByGh = useProjectedGeometries(zonesByGh, neededGhs);

  // Obs picker options — distinct names from the returned cards. No
  // separate scan of raw entries; the server already grouped by obs.
  const obsOptions = useMemo(() => {
    const s = new Set<string>();
    for (const c of cards) s.add(c.obsName);
    return Array.from(s).sort();
  }, [cards]);

  // Counters in the strip under the filter bar.
  const totalObs = cards.reduce((s, c) => s + c.totalObs, 0);
  const totalZones = cards.reduce((s, c) => s + c.zonesAffected, 0);
  const distinctGh = new Set(cards.map((c) => c.greenhouse)).size;

  // Color lookup straight from the server response (color is per-card).
  const obsToColor = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of cards) m[c.obsName] = c.color;
    return m;
  }, [cards]);

  const kind: MarkerKind = mode === "disease" ? "disease" : "pest";

  return (
    <div className="flex flex-col min-h-svh">
      <MarkerDefs />
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
                      style={{ background: obsToColor[o] || "#888" }}
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
        {gridState.loading && !gridState.data ? (
          <ProgressOverlay progress={gridState.progress} />
        ) : gridState.error ? (
          <Card className="p-8 text-sm text-[var(--sd-data-red)]">
            Failed to load: {gridState.error}
          </Card>
        ) : !cards.length ? (
          <Card className="p-12 text-center">
            <CardTitle className="text-base">No matching observations</CardTitle>
            <CardDescription className="mt-1">
              Widen the date range or pick a different{" "}
              {mode === "pest" ? "pest" : "disease"}.
            </CardDescription>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {cards.map((c) => {
              const geom = geometryByGh[c.greenhouse];
              const markers: BedMarker[] = (c.recent[0]?.zoneObs
                ? Object.entries(c.recent[0].zoneObs).map(([zone, count]) => ({
                    zone,
                    count,
                    kind,
                    color: c.color,
                  }))
                : []) as BedMarker[];
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
                    {geom ? (
                      <BedSvg
                        geometry={geom}
                        markers={markers}
                        className="w-full h-auto min-h-[200px] max-h-[260px]"
                      />
                    ) : (
                      <div className="text-[0.72rem] text-muted-foreground border rounded-md p-3 bg-[var(--sd-bg-soft)] min-h-[200px] flex items-center justify-center">
                        {zonesByGh[c.greenhouse]
                          ? "Projecting…"
                          : "Zone geometry not available for this greenhouse."}
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

      {/* Expanded modal — 3-date strip. Markers come from the same payload
          the card thumbnail used; no extra fetch on open. */}
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
                    const geom = geometryByGh[picked.greenhouse];
                    const dayMarkers: BedMarker[] = slice
                      ? Object.entries(slice.zoneObs).map(([zone, count]) => ({
                          zone,
                          count,
                          kind,
                          color: picked.color,
                        }))
                      : [];
                    const total = slice
                      ? Object.values(slice.zoneObs).reduce(
                          (a, b) => a + b,
                          0,
                        )
                      : 0;
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
                              {total}
                            </Badge>
                          ) : (
                            <span className="text-[0.7rem] text-muted-foreground">
                              —
                            </span>
                          )}
                        </div>
                        {slice && geom ? (
                          <>
                            <div className="text-xs font-medium tabular-nums">
                              {slice.date}
                            </div>
                            <BedSvg
                              geometry={geom}
                              markers={dayMarkers}
                              className="min-h-[420px] [&_svg]:max-h-[520px] [&_svg]:w-full"
                            />
                            <div className="text-[0.7rem] text-muted-foreground">
                              {Object.keys(slice.zoneObs).length} affected zone
                              {Object.keys(slice.zoneObs).length === 1 ? "" : "s"}
                            </div>
                          </>
                        ) : slice ? (
                          <div className="flex-1 flex items-center justify-center min-h-[260px] text-[0.72rem] text-muted-foreground border-dashed border rounded-md bg-[var(--sd-bg-soft)]">
                            Projecting bed geometry…
                          </div>
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

              {picked.recent.length > 1 && (
                <div className="flex flex-wrap items-center gap-3 text-[0.72rem] text-muted-foreground border-t pt-2">
                  <span className="font-medium text-foreground">Trend</span>
                  {picked.recent
                    .slice()
                    .reverse()
                    .map((s, i, arr) => {
                      const total = Object.values(s.zoneObs).reduce(
                        (a, b) => a + b,
                        0,
                      );
                      const prevTotal =
                        i > 0
                          ? Object.values(arr[i - 1].zoneObs).reduce(
                              (a, b) => a + b,
                              0,
                            )
                          : null;
                      const delta =
                        prevTotal != null ? total - prevTotal : null;
                      return (
                        <span
                          key={s.date}
                          className="inline-flex items-center gap-1.5 tabular-nums"
                        >
                          <span className="text-muted-foreground">
                            {s.date}
                          </span>
                          <span className="font-semibold text-foreground">
                            {total}
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
                <span className="inline-flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ background: picked.color }}
                  />
                  {picked.obsName} — one marker per affected zone
                </span>
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
    </div>
  );
}
