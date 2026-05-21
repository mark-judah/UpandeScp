/**
 * Heatmaps grid — bed-line plots with instanced observation markers.
 *
 * Data: ``upande_scp.serverscripts.dashboard_aggregates.heatmaps_grid``
 *       returns every (greenhouse × pest|disease) card in the filter
 *       date range, irrespective of mode. The page filters client-side
 *       via the Trends-style tristate pickers — no extra server hops
 *       when the user narrows obs or stations.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Maximize2,
  ChevronDown,
  MapPin,
  Sparkles,
  RefreshCw,
} from "lucide-react";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { DatePicker } from "@/components/DatePicker";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import {
  fetchBedsAndZones,
  fetchCrops,
  fetchFarmsAndWarehouses,
  DEFAULT_CROP,
} from "@/lib/scouting-api";
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
import { TristateTree } from "./trends/TristateTree";
import {
  buildStationTree,
  buildObsTree,
  parseSelection,
  parseObs,
} from "./trends/aggregate";

function ghOf(zoneName: string): string {
  const i = zoneName.indexOf(" - Bed ");
  return i >= 0 ? zoneName.slice(0, i) : zoneName.split(" - ")[0];
}

function defaultRange(): { from: string; to: string } {
  // Previous one week. Even though the page won't fetch until the
  // operator picks a farm or greenhouse, having a sensible range
  // pre-filled means the first pick lands a meaningful result.
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 7);
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
  const [crop, setCrop] = useState<string>(DEFAULT_CROP);
  const [{ from, to }, setRange] = useState(defaultRange);
  const [crops, setCrops] = useState<
    Array<{ name: string; crop_name: string; farms?: string[] }>
  >([{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }]);
  const [farmsByGh, setFarmsByGh] = useState<Record<string, string>>({});
  const [stationChecks, setStationChecks] = useState<Set<string>>(new Set());
  const [obsChecks, setObsChecks] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<HeatmapCard | null>(null);

  // Bootstrap data: crop list + farm→greenhouse map for the tree.
  useEffect(() => {
    fetchCrops().then((r) => {
      if (!r.length) return;
      const hasDefault = r.some((c) => c.crop_name === DEFAULT_CROP);
      setCrops(
        hasDefault
          ? r
          : [{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }, ...r],
      );
    });
    fetchFarmsAndWarehouses().then((farms) => {
      const ghToFarm: Record<string, string> = {};
      Object.entries(farms).forEach(([farm, ghs]) => {
        (ghs || []).forEach((g) => (ghToFarm[g] = farm));
      });
      setFarmsByGh(ghToFarm);
    });
  }, []);

  // Server-side filter: only the crop, date range, and explicit greenhouse
  // selections (if any) go to the server. Obs filtering is purely
  // client-side from the returned card list.
  const selections = useMemo(
    () =>
      Array.from(stationChecks)
        .map(parseSelection)
        .filter((s): s is NonNullable<typeof s> => !!s),
    [stationChecks],
  );

  // Translate the tristate picker selections into a flat greenhouses
  // list for the server. Empty list = no greenhouse filter (return all).
  // We treat a "farm:Karen" check as "every greenhouse on Karen" by
  // walking farmsByGh; "station:Karen|GH 01" passes the literal gh through.
  const greenhouseFilter = useMemo(() => {
    const set = new Set<string>();
    for (const s of selections) {
      if (s.kind === "station") {
        set.add(s.station);
      } else {
        for (const [gh, f] of Object.entries(farmsByGh)) {
          if (f === s.farm) set.add(gh);
        }
      }
    }
    return Array.from(set);
  }, [selections, farmsByGh]);

  const aggFilters = useMemo(
    () => ({
      from_date: from,
      to_date: to,
      crop: crop === DEFAULT_CROP ? "" : crop,
      greenhouses: greenhouseFilter,
    }),
    [from, to, crop, greenhouseFilter],
  );

  // Only fire the server call once the operator has narrowed the scope
  // by at least one farm or greenhouse. Loading every greenhouse on page
  // open is hectic on a busy site and adds no value when the user
  // already knows which farm they're investigating.
  const hasScope = greenhouseFilter.length > 0;
  const gridState = useDashboardAggregate<HeatmapsGridPayload>(
    "heatmaps_grid",
    aggFilters as any,
    hasScope,
  );
  const cards = gridState.data?.cards ?? [];

  // Client-side obs filter from the tristate selections. Empty = all.
  const obsFilter = useMemo(() => {
    const list = Array.from(obsChecks)
      .map(parseObs)
      .filter((o): o is NonNullable<typeof o> => !!o);
    return new Set(list.map((o) => `${o.kind}::${o.name}`));
  }, [obsChecks]);

  const visibleCards = useMemo(() => {
    if (!obsFilter.size) return cards;
    return cards.filter((c) =>
      obsFilter.has(`${c.obsKind}::${c.obsName}`),
    );
  }, [cards, obsFilter]);

  // Bed/zone geometry: fetched once, projected per greenhouse on demand.
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);
  const zonesByGh = useMemo(() => indexZonesByGh(zones), [zones]);
  const neededGhs = useMemo(
    () => Array.from(new Set(visibleCards.map((c) => c.greenhouse))),
    [visibleCards],
  );
  const geometryByGh = useProjectedGeometries(zonesByGh, neededGhs);

  // Station tree is built from the full farm map (every farm/greenhouse the
  // tenant has) so the operator can browse and pick before any cards exist.
  // No counts here — counts come from the cards once a pick has been made.
  const stationTree = useMemo(() => {
    const farmStations: Record<string, Record<string, number>> = {};
    // Optional in-range counts overlay (only on greenhouses that have cards).
    const ghTotals: Record<string, number> = {};
    for (const c of cards) {
      ghTotals[c.greenhouse] = (ghTotals[c.greenhouse] || 0) + c.totalObs;
    }
    for (const [gh, farm] of Object.entries(farmsByGh)) {
      if (!farmStations[farm]) farmStations[farm] = {};
      farmStations[farm][gh] = ghTotals[gh] || 0;
    }
    return buildStationTree(farmStations);
  }, [farmsByGh, cards]);

  // Observation tree is built from the returned cards (so it surfaces only
  // pests/diseases that actually appear in the current scope). Empty until
  // the first server response comes back.
  const obsTree = useMemo(() => {
    const pestCounts: Record<string, number> = {};
    const diseaseCounts: Record<string, number> = {};
    for (const c of cards) {
      if (c.obsKind === "pest")
        pestCounts[c.obsName] = (pestCounts[c.obsName] || 0) + c.totalObs;
      else
        diseaseCounts[c.obsName] =
          (diseaseCounts[c.obsName] || 0) + c.totalObs;
    }
    return buildObsTree(pestCounts, diseaseCounts);
  }, [cards]);

  // Counters strip
  const totalObs = visibleCards.reduce((s, c) => s + c.totalObs, 0);
  const totalZones = visibleCards.reduce((s, c) => s + c.zonesAffected, 0);
  const distinctGh = new Set(visibleCards.map((c) => c.greenhouse)).size;

  return (
    <div className="flex flex-col min-h-svh">
      <MarkerDefs />
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Heatmaps
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Per-greenhouse zone intensity · pest &amp; disease markers
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-32">
              <Label htmlFor="hm-crop">Crop</Label>
              <Select value={crop} onValueChange={setCrop}>
                <SelectTrigger id="hm-crop" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {crops.map((c) => (
                    <SelectItem key={c.crop_name} value={c.crop_name}>
                      {c.crop_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label>From</Label>
              <DatePicker
                value={from}
                onChange={(v) => setRange({ from: v, to })}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label>To</Label>
              <DatePicker
                value={to}
                onChange={(v) => setRange({ from, to: v })}
              />
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2">
                  <MapPin className="h-3.5 w-3.5" />
                  Farms
                  <span className="text-muted-foreground tabular-nums">
                    {selections.length || "—"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <TristateTree
                  nodes={stationTree}
                  checked={stationChecks}
                  onChange={setStationChecks}
                  emptyHint="No farms configured"
                  searchPlaceholder="Search farms or greenhouses…"
                />
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2">
                  <Sparkles className="h-3.5 w-3.5" />
                  Observations
                  <span className="text-muted-foreground tabular-nums">
                    {obsChecks.size
                      ? Array.from(obsChecks).filter((id) =>
                          id.startsWith("obs:") && !id.startsWith("obs:group:"),
                        ).length || "—"
                      : "—"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80">
                <TristateTree
                  nodes={obsTree}
                  checked={obsChecks}
                  onChange={setObsChecks}
                  emptyHint={
                    hasScope
                      ? "No observations in date range"
                      : "Pick farms first"
                  }
                  searchPlaceholder="Search observations…"
                />
              </PopoverContent>
            </Popover>

            <Button
              variant="outline"
              size="sm"
              onClick={() => gridState.reload({ force: true })}
              className="h-9"
              title="Reload (force cache refresh)"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>
          </div>
        </div>

        {gridState.error && (
          <div className="text-xs text-[var(--sd-data-red)]">
            Failed to load: {gridState.error}
          </div>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b bg-card/50">
        <span className="ml-auto tabular-nums">
          {distinctGh} greenhouses · {totalZones} zones · {totalObs}{" "}
          observation{totalObs === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex-1 px-4 md:px-6 py-4 md:py-6">
        {!hasScope ? (
          <Card className="p-12 flex flex-col items-center justify-center text-center gap-2">
            <div className="h-10 w-10 rounded-full bg-[var(--sd-pistachio)] flex items-center justify-center">
              <MapPin className="h-5 w-5 text-muted-foreground" />
            </div>
            <CardTitle className="text-base">
              Pick farms or greenhouses to start
            </CardTitle>
            <CardDescription className="max-w-md">
              Use the Farms picker above. Click a farm for every greenhouse
              under it, or drill into specific greenhouses. Nothing loads
              until you narrow the scope.
            </CardDescription>
          </Card>
        ) : gridState.loading ? (
          <ProgressOverlay progress={gridState.progress} />
        ) : !visibleCards.length ? (
          <Card className="p-12 text-center">
            <CardTitle className="text-base">No matching observations</CardTitle>
            <CardDescription className="mt-1">
              Widen the date range, pick more stations, or clear the
              observation filter.
            </CardDescription>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {visibleCards.map((c) => {
              const geom = geometryByGh[c.greenhouse];
              const kind: MarkerKind =
                c.obsKind === "disease" ? "disease" : "pest";
              const markers: BedMarker[] = c.recent[0]?.zoneObs
                ? Object.entries(c.recent[0].zoneObs).map(([zone, count]) => ({
                    zone,
                    count,
                    kind,
                    color: c.color,
                  }))
                : [];
              return (
                <Card
                  key={`${c.greenhouse}::${c.obsKind}::${c.obsName}`}
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
                          <span className="capitalize">{c.obsKind}</span> ·{" "}
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
                    const kind: MarkerKind =
                      picked.obsKind === "disease" ? "disease" : "pest";
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
                              {Object.keys(slice.zoneObs).length === 1
                                ? ""
                                : "s"}
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
