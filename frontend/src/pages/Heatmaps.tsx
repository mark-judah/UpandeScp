/**
 * Heatmaps grid — bed-line plots with instanced observation markers.
 *
 * Data: ``upande_scp.serverscripts.dashboard_aggregates.heatmaps_grid``
 *       returns every (greenhouse × pest|disease) card in the filter
 *       date range, irrespective of mode. The page filters client-side
 *       via the Trends-style tristate pickers — no extra server hops
 *       when the user narrows obs or stations.
 */

import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import {
  Maximize2,
  ChevronDown,
  MapPin,
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
import { DatePicker } from "@/components/DatePicker";
import { METHOD, useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { call } from "@/lib/frappe";
import {
  fetchBedsAndZones,
  fetchCrops,
  fetchFarmsAndWarehousesResult,
  DEFAULT_CROP,
} from "@/lib/scouting-api";
import { flattenZones, type ZoneFeature } from "./maps/zone-utils";
import { ymd } from "@/lib/utils";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { MarkerDefs, type MarkerKind } from "./maps/MarkerDefs";
import {
  BedSvg,
  markersFromZoneStages,
  type BedMarker,
  type ZoneStage,
} from "./maps/BedSvg";
import { StageLegend } from "./maps/StageLegend";
import { hasWebGL } from "@/lib/webgl";
import type { TerrainWeekData } from "./maps/Terrain3D";

// Lazy: three.js is a ~508 kB chunk and the 2D heatmap must not pay for it.
const Terrain3D = lazy(() =>
  import("./maps/Terrain3D").then((m) => ({ default: m.Terrain3D })),
);
import {
  projectGeometry,
  type ProjectedGeometry,
  type ZoneGeoLike,
} from "./maps/bed-projection";
import { TristateTree } from "./trends/TristateTree";
import {
  buildStationTree,
  parseSelection,
  parseObs,
} from "./trends/aggregate";
import { WeatherCard } from "@/components/WeatherCard";
import { ScoutRow, type Scout } from "@/components/ScoutAvatar";
import { WeatherHistory, useWeatherHistory } from "@/components/WeatherHistory";
import { cn } from "@/lib/utils";

/** "2026-W29" -> "Week 29". The payload's `date` is an ISO-week label now. */
function weekLabel(v: string): string {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(v || "");
  return m ? `Week ${Number(m[2])}` : v || "";
}

/** Why a week is only half a picture, for the incomplete badge's tooltip. */
function coverageNote(r: CardRecent): string {
  const odd = r.oddZones ?? 0;
  const even = r.evenZones ?? 0;
  const missing = odd > even ? "even" : "odd";
  return (
    `Only ${missing === "even" ? "odd" : "even"}-numbered beds were scouted ` +
    `this week (${r.sessions ?? 0} session${(r.sessions ?? 0) === 1 ? "" : "s"}` +
    `${r.sessionDates?.length ? `: ${r.sessionDates.join(", ")}` : ""}). ` +
    `The ${missing} beds were not visited — blank zones there mean "not looked at", not "clean".`
  );
}

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

type CardRecent = {
  /** ISO-week label ("2026-W29"). Named `date` for contract continuity, but a
   *  week now — a single session covers only the odd or only the even beds, so
   *  a per-session heatmap drew half a greenhouse and showed the unvisited half
   *  as clean. Merging a week's sessions reassembles the house. */
  date: string;
  zoneObs: Record<string, number>;
  zoneStages?: Record<string, ZoneStage[]>;
  /** Scouting sessions that made up this week. */
  sessions?: number;
  sessionDates?: string[];
  oddZones?: number;
  evenZones?: number;
  scouts?: Scout[];
  coveragePct?: number | null;
  bedsScouted?: number;
  bedsTotal?: number;
  /** Both bed parities present in real proportion — i.e. the whole greenhouse
   *  was actually seen. False for 101 of 229 greenhouse-weeks on this site, so
   *  it must be shown, not assumed. */
  complete?: boolean;
};

interface HeatmapCard {
  greenhouse: string;
  obsName: string;
  obsKind: "pest" | "disease";
  color: string;
  totalObs: number;
  zonesAffected: number;
  lastDate: string;
  recent: CardRecent[];
}

interface HeatmapsGridPayload {
  cards: HeatmapCard[];
  /** Newest date_of_capture on file, so an empty range can explain itself. */
  latestScoutingDate?: string;
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

export function Heatmaps({ initialCrop }: { initialCrop?: string } = {}) {
  const [crop, setCrop] = useState<string>(initialCrop ?? DEFAULT_CROP);
  const [{ from, to }, setRange] = useState(defaultRange);
  const [crops, setCrops] = useState<
    Array<{ name: string; crop_name: string; farms?: string[] }>
  >([{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }]);
  const [farmsByGh, setFarmsByGh] = useState<Record<string, string>>({});
  // Distinguishes "this farm list is empty" from "we could not fetch it". The
  // picker used to say "No farms configured" for both, which sent people
  // looking for a configuration problem that didn't exist.
  const [farmsError, setFarmsError] = useState<"stale-session" | "failed" | null>(
    null,
  );
  const [stationChecks, setStationChecks] = useState<Set<string>>(new Set());
  const [obsChecks, setObsChecks] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<HeatmapCard | null>(null);
  const [pickedDetail, setPickedDetail] = useState<CardRecent[] | null>(null);
  /** Move the range to the week containing the newest scouting entry. */
  const jumpToLatest = (iso: string) => {
    const end = new Date(iso + "T00:00:00");
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    setRange({ from: ymd(start), to: ymd(end) });
  };
  const [show3D, setShow3D] = useState(false);
  /** Farm of the opened card, for its weather history in the modal. */
  const pickedFarm = picked ? farmsByGh[picked.greenhouse] || "" : "";
  // Weather follows the weeks THIS greenhouse was scouted, not a trailing
  // window from today — on this data the newest scouting is ~29 days old, so a
  // "last 5 weeks" window barely overlaps what it's meant to explain.
  const pickedWeather = useWeatherHistory(pickedFarm, from, to);
  const [terrain, setTerrain] = useState<TerrainWeekData[] | null>(null);

  // 3D is opt-in per card and needs its own (longer) week history, so it is
  // fetched only when the toggle is switched on.
  useEffect(() => {
    if (!picked || !show3D) return;
    let cancelled = false;
    setTerrain(null);
    call<{ weeks: TerrainWeekData[] }>(METHOD.heatmap_terrain, {
      from_date: from, to_date: to, crop,
      greenhouse: picked.greenhouse,
      obs_name: picked.obsName,
      obs_kind: picked.obsKind,
    })
      .then((r) => { if (!cancelled) setTerrain(r?.weeks ?? []); })
      .catch(() => { if (!cancelled) setTerrain([]); });
    return () => { cancelled = true; };
  }, [picked, show3D, from, to, crop]);

  // Reset the view whenever a different card is opened.
  useEffect(() => { setShow3D(false); setTerrain(null); }, [picked]);

  // The grid ships only recent[0] (~1/3 of the old payload); fetch the
  // full 3-date history on demand when a card is opened. recent[0] falls
  // back to what the grid already has so the thumbnail renders instantly
  // with no flash while the other two dates load.
  useEffect(() => {
    if (!picked) { setPickedDetail(null); return; }
    let cancelled = false;
    setPickedDetail(null);
    call<{ recent: CardRecent[] }>(
      METHOD.heatmap_card_detail,
      {
        from_date: from, to_date: to, crop,
        greenhouse: picked.greenhouse,
        obs_name: picked.obsName,
        obs_kind: picked.obsKind,
      },
    )
      .then((r) => {
        if (cancelled) return;
        // A legitimate empty response must not blank the modal down to
        // "no data" — fall back to the one date the grid already has.
        const recent = r?.recent ?? [];
        setPickedDetail(recent.length ? recent : picked.recent);
      })
      .catch(() => !cancelled && setPickedDetail(picked.recent));
    return () => { cancelled = true; };
  }, [picked, from, to, crop]);

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
    fetchFarmsAndWarehousesResult().then(({ farms, error }) => {
      const ghToFarm: Record<string, string> = {};
      Object.entries(farms).forEach(([farm, ghs]) => {
        (ghs || []).forEach((g) => (ghToFarm[g] = farm));
      });
      setFarmsByGh(ghToFarm);
      setFarmsError(error ?? null);
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
  // Most recent scouting date on file. The page defaults to the last seven
  // days, so once data is older than that every card vanishes and the page
  // reads as broken rather than as out of range — say so instead.
  const latestScouting = gridState.data?.latestScoutingDate || "";
  const latestOutsideRange = !!latestScouting && latestScouting < from;

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

  // Counters strip
  const totalObs = visibleCards.reduce((s, c) => s + c.totalObs, 0);
  const totalZones = visibleCards.reduce((s, c) => s + c.zonesAffected, 0);
  const distinctGh = new Set(visibleCards.map((c) => c.greenhouse)).size;

  // Right-column obs chip list, derived from the cards in scope. Single-
  // select model: clicking a chip swaps the obsChecks set to just that
  // observation; clicking "All" clears it. Keeps the tristate state model
  // around (other places still use it) but exposes a simpler UI.
  const obsChipOptions = useMemo(() => {
    const byKey: Record<
      string,
      { id: string; label: string; color: string; count: number }
    > = {};
    for (const c of cards) {
      const id = `obs:${c.obsKind}:${c.obsName}`;
      if (!byKey[id]) {
        byKey[id] = {
          id,
          label: c.obsName,
          color: c.color,
          count: 0,
        };
      }
      byKey[id].count += c.totalObs;
    }
    return Object.values(byKey).sort((a, b) => b.count - a.count);
  }, [cards]);

  const selectedObs = useMemo(() => {
    const ids = Array.from(obsChecks).filter(
      (id) => id.startsWith("obs:") && !id.startsWith("obs:group:"),
    );
    return ids.length === 1 ? ids[0] : null;
  }, [obsChecks]);

  // Pick a farm for the weather card. Use the first farm-typed selection;
  // otherwise infer from the first station-typed selection via farmsByGh.
  const weatherFarm = useMemo(() => {
    for (const s of selections) {
      if (s.kind === "farm") return s.farm;
      const f = farmsByGh[s.station];
      if (f) return f;
    }
    return "";
  }, [selections, farmsByGh]);

  // The grid ships only recent[0]; the modal reads the on-demand-fetched
  // 3-date detail once it lands, falling back to what the grid already
  // has so the first date renders instantly with no flash.
  const modalRecent: CardRecent[] = picked ? (pickedDetail ?? picked.recent) : [];
  // True only during the in-flight fetch window — slots 2/3 render a
  // loading state instead of asserting "No earlier scouting recorded",
  // which would otherwise be a false statement of fact while the detail
  // fetch (measured ~542ms cold) is still in flight.
  const isLoadingDetail = picked !== null && pickedDetail === null;

  return (
    <div className="flex flex-col min-h-svh">
      <MarkerDefs />
      <PageHeader
        title="Heatmaps"
        eyebrow={<>Per-greenhouse zone intensity · pest &amp; disease markers</>}
      >
        {!initialCrop && (
          <Select value={crop} onValueChange={setCrop}>
            <SelectTrigger aria-label="Crop" className={HEADER_PILL}>
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
        )}

        <DatePicker value={from} onChange={(v) => setRange({ from: v, to })} />
        <DatePicker value={to} onChange={(v) => setRange({ from, to: v })} />

        {/* Multi-select: check any farms and/or greenhouses to plot. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className={HEADER_PILL}>
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
              emptyHint={
                farmsError === "stale-session"
                  ? "This page is out of date — reload to sign the session back in."
                  : farmsError === "failed"
                  ? "Couldn't load the farm list. Check your connection and reload."
                  : "No farms configured"
              }
              searchPlaceholder="Search farms or greenhouses…"
            />
          </PopoverContent>
        </Popover>

        <HeaderIconButton
          onClick={() => gridState.reload({ force: true })}
          title="Reload (force cache refresh)"
        >
          <RefreshCw className="h-4 w-4" />
        </HeaderIconButton>
      </PageHeader>

      {gridState.error && (
        <div className="text-xs text-[var(--sd-data-red)] px-4 md:px-6">
          Failed to load: {gridState.error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground">
        <span className="ml-auto tabular-nums">
          {distinctGh} greenhouses · {totalZones} zones · {totalObs}{" "}
          observation{totalObs === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex-1 px-4 md:px-6 py-4 md:py-6 grid gap-3 lg:grid-cols-[1fr_20rem]">
        {/* Left column — heatmap cards (taller). */}
        <div className="min-w-0">
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
          <LoadingOverlay
            open
            progress={gridState.progress?.percent ?? null}
            label={gridState.progress?.label}
          />
        ) : !visibleCards.length ? (
          <Card className="p-12 text-center">
            <CardTitle className="text-base">
              {latestOutsideRange
                ? "No scouting in this date range"
                : "No matching observations"}
            </CardTitle>
            <CardDescription className="mt-1">
              {latestOutsideRange ? (
                <>
                  Nothing was scouted between {from} and {to}. The most recent
                  scouting entry is <strong>{latestScouting}</strong>.
                </>
              ) : (
                <>
                  Widen the date range, pick more stations, or clear the
                  observation filter.
                </>
              )}
            </CardDescription>
            {latestOutsideRange && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 mx-auto"
                onClick={() => jumpToLatest(latestScouting)}
              >
                Show the week of {latestScouting}
              </Button>
            )}
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleCards.map((c) => {
              const geom = geometryByGh[c.greenhouse];
              const kind: MarkerKind =
                c.obsKind === "disease" ? "disease" : "pest";
              const markers: BedMarker[] = c.recent[0]?.zoneStages
                ? markersFromZoneStages(c.recent[0].zoneStages, c.color)
                : c.recent[0]?.zoneObs
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
                          {c.lastDate ? ` · ${weekLabel(c.lastDate)}` : ""}
                          {c.recent[0] && c.recent[0].complete === false ? (
                            <span
                              title={coverageNote(c.recent[0])}
                              className="ml-1 text-[var(--sd-data-amber)]"
                            >
                              · half scouted
                            </span>
                          ) : null}
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
                        className="w-full h-auto min-h-[340px] max-h-[480px]"
                      />
                    ) : (
                      <div className="text-[0.72rem] text-muted-foreground border rounded-md p-3 bg-[var(--sd-bg-soft)] min-h-[340px] flex items-center justify-center">
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

        {/* Right column — contextual weather + obs chip filter. */}
        <aside className="flex flex-col gap-3 min-w-0">
          {weatherFarm ? <WeatherCard farm={weatherFarm} /> : null}
          <Card className="p-3">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Observation filter
              </CardTitle>
              <CardDescription className="text-[0.7rem]">
                {obsChipOptions.length
                  ? "Pick one, or 'All' to see every observation."
                  : hasScope
                    ? "No observations in date range."
                    : "Pick farms first."}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="flex flex-wrap gap-1.5">
                <ObsChip
                  label="All"
                  active={!selectedObs}
                  onClick={() => setObsChecks(new Set())}
                />
                {obsChipOptions.map((opt) => (
                  <ObsChip
                    key={opt.id}
                    label={opt.label}
                    color={opt.color}
                    count={opt.count}
                    active={selectedObs === opt.id}
                    onClick={() =>
                      setObsChecks(
                        selectedObs === opt.id ? new Set() : new Set([opt.id]),
                      )
                    }
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        </aside>
      </div>

      <Dialog open={!!picked} onOpenChange={(o) => !o && setPicked(null)}>
        <DialogContent className="max-w-[min(92vw,1080px)] max-h-[80vh] overflow-y-auto">
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
                  {hasWebGL() && (
                    <button
                      type="button"
                      onClick={() => setShow3D((v) => !v)}
                      className="ml-auto rounded-md border px-2 py-0.5 text-[0.7rem] font-normal hover:bg-muted"
                    >
                      {show3D ? "2D" : "3D"}
                    </button>
                  )}
                </DialogTitle>
                <DialogDescription>
                  {picked.totalObs} observation
                  {picked.totalObs === 1 ? "" : "s"} across{" "}
                  {picked.zonesAffected} zone
                  {picked.zonesAffected === 1 ? "" : "s"} · last 3 scouted
                  weeks, oldest to latest (left to right)
                </DialogDescription>
              </DialogHeader>

              {pickedFarm && (
                <WeatherHistory
                  farm={pickedFarm}
                  className="rounded-md border p-2"
                  highlightWeek={picked.lastDate}
                  fromDate={from}
                  toDate={to}
                  onlyWeeks={modalRecent.map((r) => r.date)}
                />
              )}

              {show3D ? (
                terrain === null ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    Building terrain…
                  </div>
                ) : (
                  <Suspense
                    fallback={
                      <div className="p-6 text-center text-sm text-muted-foreground">
                        Loading 3D…
                      </div>
                    }
                  >
                  <Terrain3D
                    weeks={terrain}
                    weather={pickedWeather ?? undefined}
                    positions={Object.fromEntries(
                      Object.entries(
                        geometryByGh[picked.greenhouse]?.zoneCentroids ?? {},
                      ).map(([zone, c]) => [zone, { x: c.cx, y: c.cy }]),
                    )}
                    className="min-h-[420px]"
                  />
                  </Suspense>
                )
              ) : modalRecent.length === 0 ? (
                <div className="text-sm text-muted-foreground p-6 text-center border rounded-md bg-[var(--sd-bg-soft)]">
                  No dated scouting entries to plot.
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {[0, 1, 2].map((i) => {
                    const slice = modalRecent[i];
                    // recent[] is oldest-first, so the LAST slice is the
                    // latest week — label by distance from the end.
                    const fromEnd = modalRecent.length - 1 - i;
                    const label =
                      fromEnd === 0
                        ? "Latest week"
                        : fromEnd === 1
                        ? "1 week earlier"
                        : `${fromEnd} weeks earlier`;
                    const geom = geometryByGh[picked.greenhouse];
                    const kind: MarkerKind =
                      picked.obsKind === "disease" ? "disease" : "pest";
                    const dayMarkers: BedMarker[] = slice?.zoneStages
                      ? markersFromZoneStages(slice.zoneStages, picked.color)
                      : slice
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
                            {label}
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
                            <div className="flex items-center gap-2 text-xs font-medium tabular-nums">
                              <span>{weekLabel(slice.date)}</span>
                              {slice.complete === false && (
                                <span
                                  title={coverageNote(slice)}
                                  className="rounded-full border border-[var(--sd-data-amber)] px-1.5 py-px text-[0.6rem] font-normal text-[var(--sd-data-amber)]"
                                >
                                  half scouted
                                </span>
                              )}
                            </div>
                            <BedSvg
                              geometry={geom}
                              markers={dayMarkers}
                              className="min-h-[420px] [&_svg]:max-h-[520px] [&_svg]:w-full"
                            />
                            <StageLegend markers={dayMarkers} className="px-1" />
                            <ScoutRow
                              scouts={slice.scouts}
                              coveragePct={slice.coveragePct}
                              bedsScouted={slice.bedsScouted}
                              bedsTotal={slice.bedsTotal}
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
                        ) : isLoadingDetail ? (
                          <div className="flex-1 flex items-center justify-center min-h-[260px] text-[0.72rem] text-muted-foreground border-dashed border rounded-md bg-[var(--sd-bg-soft)]">
                            Loading…
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

              {modalRecent.length > 1 && (
                <div className="flex flex-wrap items-center gap-3 text-[0.72rem] text-muted-foreground border-t pt-2">
                  <span className="font-medium text-foreground">Trend</span>
                  {modalRecent
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
                          <span
                            className="text-muted-foreground"
                            title={s.complete === false ? coverageNote(s) : undefined}
                          >
                            {weekLabel(s.date)}
                            {s.complete === false ? "*" : ""}
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

/** Single-select chip used in the right-column observation filter.
 *  When ``color`` is set it tints the indicator dot and (for active
 *  chips) the chip's border so the legend matches the map markers. */
function ObsChip({
  label,
  color,
  count,
  active,
  onClick,
}: {
  label: string;
  color?: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[0.7rem] transition-colors",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-muted-foreground hover:bg-muted",
      )}
      style={
        active && color
          ? { borderColor: color, background: color, color: "white" }
          : undefined
      }
    >
      {color ? (
        <span
          className="h-2 w-2 rounded-full border"
          style={{ background: color }}
          aria-hidden
        />
      ) : null}
      <span className="font-medium">{label}</span>
      {typeof count === "number" ? (
        <span className="tabular-nums opacity-80">{count}</span>
      ) : null}
    </button>
  );
}
