import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { ChevronDown } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { MapControlPanel } from "@/components/maps/MapControlPanel";
import { MapKpiPill } from "@/components/maps/MapKpiPill";
import { LoadProgress, RowsSkeleton, TextSkeleton, firstLoad } from "@/components/Loading";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ALL, RangeHeader, type RangeFilterValue } from "./maps/RangeHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HEADER_PILL } from "@/components/header-controls";
import {
  DEFAULT_CROP,
  fetchFarmsAndWarehouses,
  fetchTrapLocations,
  type TrapLocation,
  type TrapLocations,
} from "@/lib/scouting-api";
import { flyToFarm, useMapSettings } from "@/hooks/use-map-settings";
import {
  pestColor,
  readableInk,
  useObservationColors,
} from "@/lib/observation-colors";
import { currentWeekRange } from "@/lib/utils";
import type { ScoutingEntry } from "@/lib/scouting-types";
import { prefersReducedMotion, trapMarkerHtml, trapPulse } from "@/lib/trap-pulse";
import { shortHouse } from "@/lib/places";
import { TrapReadingCard } from "@/components/traps/TrapReadingCard";



interface TrapAgg {
  trap: string;
  pest: string;
  greenhouse: string;
  greenhouseShort: string;
  zone: string;
  location: string;
  totalCount: number;
  /** Highest single-entry count across the selected window. */
  maxCount: number;
  /** Date the highest count was recorded — surfaced in the popup. */
  maxDate: string;
  entryCount: number;
  days: Set<string>;
  latSum: number;
  lngSum: number;
  latN: number;
  /** The trap's fixed location (Trap.geojson), when it has one. */
  fixed?: TrapLocation;
  /** The newest reading in the window — who recorded it, when, how many. */
  latest: { date: string; time: string; scout: string; count: number; pest: string } | null;
}

/** "#d9a514" + 0.45 → "rgba(217,165,20,0.45)"; anything else → fallback. */
export function withAlpha(hex: string | undefined, a: number, fallback: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function stampOf(e: ScoutingEntry): string {
  return `${e.date_of_capture || ""} ${e.time_of_capture || ""}`;
}

/** Where a trap is drawn: its fixed location when it has one, else the
 *  average of its entries' coordinates, else nowhere. */
export function trapPosition(t: TrapAgg): { lat: number; lng: number } | null {
  if (t.fixed) return { lat: t.fixed.lat, lng: t.fixed.lng };
  if (t.latN === 0) return null;
  return { lat: t.latSum / t.latN, lng: t.lngSum / t.latN };
}

function readCoord(v: any): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  return n;
}

function readEntryCoords(
  e: any,
): { lat: number; lng: number } | null {
  const lat = readCoord(e?.latitude);
  const lng = readCoord(e?.longitude);
  if (lat == null || lng == null) return null;
  // (0,0) is the Atlantic — treat as missing.
  if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return null;
  return { lat, lng };
}

export function aggregateTraps(
  entries: ScoutingEntry[],
  fixed: TrapLocations = {},
): TrapAgg[] {
  const map = new Map<string, TrapAgg>();
  for (const e of entries) {
    const coords = readEntryCoords(e);
    for (const t of e.trap_scouting_entry || []) {
      if (!t.trap) continue;
      const key = t.trap;
      let agg = map.get(key);
      if (!agg) {
        const fullGh = e.greenhouse || e.block || "";
        agg = {
          trap: t.trap,
          pest: t.pest || "—",
          greenhouse: fullGh,
          greenhouseShort: shortHouse(fullGh),
          zone: e.zone || e.tree || "",
          location: t.location || "",
          totalCount: 0,
          maxCount: 0,
          maxDate: "",
          entryCount: 0,
          days: new Set(),
          latSum: 0,
          lngSum: 0,
          latN: 0,
          fixed: fixed[t.trap],
          latest: null,
        };
        map.set(key, agg);
      }
      const c = t.count || 0;
      agg.totalCount += c;
      if (c > agg.maxCount) {
        agg.maxCount = c;
        agg.maxDate = e.date_of_capture || "";
      }
      const stamp = stampOf(e);
      if (!agg.latest || stamp > `${agg.latest.date} ${agg.latest.time}`) {
        agg.latest = {
          date: e.date_of_capture || "",
          time: (e.time_of_capture || "").split(".")[0],
          scout: e.scouts_name || "",
          count: c,
          pest: t.pest || "",
        };
      }
      agg.entryCount += 1;
      if (e.date_of_capture) agg.days.add(e.date_of_capture);
      if (coords) {
        agg.latSum += coords.lat;
        agg.lngSum += coords.lng;
        agg.latN += 1;
      }
    }
  }
  return Array.from(map.values());
}

function placementNote(t: TrapAgg): string {
  const f = t.fixed;
  if (f?.source === "Manual") return "Fixed · placed manually";
  if (f) {
    const flag = f.flag ? ` · ${f.flag}` : "";
    return `GPS estimate · ${f.fixes} fixes (±${Math.round(f.spread_m)} m)${flag}`;
  }
  return `No fixed location · avg of ${t.latN} entr${t.latN === 1 ? "y" : "ies"}`;
}

type LocationFilter = "all" | "Indoor" | "Outdoor";

interface MultiPickerProps {
  label: string;
  items: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  swatch?: (item: string) => string | undefined;
  count?: (item: string) => number | undefined;
  /** While the options (which come with the data) are loading. */
  disabled?: boolean;
}

function MultiPicker({
  label,
  items,
  selected,
  onChange,
  swatch,
  count,
  disabled = false,
}: MultiPickerProps) {
  const allOn = items.length > 0 && items.every((i) => selected.has(i));
  const summary = allOn
    ? "All"
    : selected.size === 0
      ? "None"
      : `${selected.size} selected`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={HEADER_PILL} disabled={disabled}>
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground tabular-nums">{summary}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start">
        <div className="flex items-center gap-1 pb-2 mb-1 border-b">
          <button
            type="button"
            onClick={() => onChange(new Set(items))}
            className="px-2 py-1 text-[0.7rem] rounded border bg-card hover:bg-muted"
          >
            All
          </button>
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="px-2 py-1 text-[0.7rem] rounded border bg-card hover:bg-muted"
          >
            None
          </button>
          <span className="ml-auto text-[0.7rem] text-muted-foreground tabular-nums">
            {selected.size}/{items.length}
          </span>
        </div>
        {items.length === 0 ? (
          <p className="px-2 py-3 text-[0.72rem] text-muted-foreground text-center">
            No {label.toLowerCase()}
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto flex flex-col gap-0.5 pr-1">
            {items.map((item) => {
              const checked = selected.has(item);
              return (
                <label
                  key={item}
                  className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted cursor-pointer"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(v) => {
                      const next = new Set(selected);
                      if (v) next.add(item);
                      else next.delete(item);
                      onChange(next);
                    }}
                  />
                  {swatch && (
                    <span
                      className="h-3 w-3 rounded-full border shrink-0"
                      style={{ background: swatch(item) }}
                    />
                  )}
                  <span className="text-[0.75rem] flex-1 truncate">{item}</span>
                  {count && typeof count(item) === "number" && (
                    <span className="text-[0.65rem] tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {count(item)}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function TrapsMap({ initialCrop }: { initialCrop?: string } = {}) {
  const [filters, setFilters] = useState<RangeFilterValue>(() => ({
    crop: initialCrop ?? DEFAULT_CROP,
    farm: ALL,
    greenhouse: ALL,
    ...currentWeekRange(),
  }));
  const [locFilter, setLocFilter] = useState<LocationFilter>("all");
  const [pestSel, setPestSel] = useState<Set<string> | null>(null);
  const [ghSel, setGhSel] = useState<Set<string> | null>(null);
  const [farmSel, setFarmSel] = useState<Set<string> | null>(null);
  const [ghToFarm, setGhToFarm] = useState<Record<string, string>>({});
  const { pest: resolvePestColor } = useObservationColors();
  const mapSettings = useMapSettings();

  // farm → greenhouses map. Cached server-side; only hits the network on the
  // first scouting page in the session.
  useEffect(() => {
    let cancelled = false;
    fetchFarmsAndWarehouses(filters.crop)
      .then((farms) => {
        if (cancelled) return;
        const out: Record<string, string> = {};
        Object.entries(farms).forEach(([farm, ghs]) => {
          (ghs || []).forEach((g) => {
            out[g] = farm;
            // Pickers compare on the short greenhouse code (split on " - ").
            const short = shortHouse(g);
            if (short && !out[short]) out[short] = farm;
          });
        });
        setGhToFarm(out);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filters.crop]);

  const ghForCall = filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading, progress, error } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop,
  });

  // Fixed trap locations (Trap.geojson). A trap without one is drawn at the
  // average of its entries' coordinates, as before.
  const [trapLocations, setTrapLocations] = useState<TrapLocations>({});
  useEffect(() => {
    let cancelled = false;
    fetchTrapLocations().then((r) => {
      if (!cancelled) setTrapLocations(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const traps = useMemo(
    () => (data ? aggregateTraps(data.entries, trapLocations) : []),
    [data, trapLocations],
  );

  // Available farm / greenhouse / pest options derived from the aggregated
  // traps. We only show options that actually have data in the current
  // window so the pickers don't list dead farms.
  const farmOptions = useMemo(() => {
    const s = new Set<string>();
    traps.forEach((t) => {
      const farm = ghToFarm[t.greenhouseShort] || ghToFarm[t.greenhouse];
      if (farm) s.add(farm);
    });
    return Array.from(s).sort();
  }, [traps, ghToFarm]);

  const ghOptions = useMemo(() => {
    const s = new Set<string>();
    traps.forEach((t) => t.greenhouseShort && s.add(t.greenhouseShort));
    return Array.from(s).sort();
  }, [traps]);

  const pestOptions = useMemo(() => {
    const s = new Set<string>();
    traps.forEach((t) => t.pest && s.add(t.pest));
    return Array.from(s).sort();
  }, [traps]);

  const pestCounts = useMemo(() => {
    const m: Record<string, number> = {};
    traps.forEach((t) => {
      m[t.pest] = (m[t.pest] || 0) + t.totalCount;
    });
    return m;
  }, [traps]);

  // Default selections: when options arrive (i.e. data has loaded), seed the
  // selection to "all". On subsequent changes, intersect with the user's
  // previous picks. Don't run while options are still empty — that's the
  // "data not loaded yet" state, not "user deselected everything".
  useEffect(() => {
    if (!ghOptions.length) return;
    setGhSel((prev) =>
      prev == null
        ? new Set(ghOptions)
        : new Set(ghOptions.filter((g) => prev.has(g))),
    );
  }, [ghOptions]);

  useEffect(() => {
    if (!pestOptions.length) return;
    setPestSel((prev) =>
      prev == null
        ? new Set(pestOptions)
        : new Set(pestOptions.filter((p) => prev.has(p))),
    );
  }, [pestOptions]);

  useEffect(() => {
    if (!farmOptions.length) return;
    setFarmSel((prev) =>
      prev == null
        ? new Set(farmOptions)
        : new Set(farmOptions.filter((f) => prev.has(f))),
    );
  }, [farmOptions]);

  // Keep the multi-select Farms picker in sync with the header's single
  // Farm dropdown — picking a farm at the top narrows the multi-select to
  // just that farm; switching back to "All farms" restores everything.
  useEffect(() => {
    if (filters.farm === ALL) {
      if (farmOptions.length) setFarmSel(new Set(farmOptions));
    } else {
      setFarmSel(new Set([filters.farm]));
    }
  }, [filters.farm, farmOptions]);

  const visibleTraps = useMemo(() => {
    const ghSet = ghSel ?? new Set(ghOptions);
    const pestSet = pestSel ?? new Set(pestOptions);
    const farmSet = farmSel ?? new Set(farmOptions);
    return traps.filter((t) => {
      if (locFilter !== "all" && t.location !== locFilter) return false;
      if (ghOptions.length && !ghSet.has(t.greenhouseShort)) return false;
      if (pestOptions.length && !pestSet.has(t.pest)) return false;
      if (farmOptions.length) {
        const farm = ghToFarm[t.greenhouseShort] || ghToFarm[t.greenhouse];
        if (!farm || !farmSet.has(farm)) return false;
      }
      return true;
    });
  }, [
    traps,
    ghSel,
    pestSel,
    farmSel,
    ghOptions,
    pestOptions,
    farmOptions,
    locFilter,
    ghToFarm,
  ]);

  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const selectTimer = useRef<number | null>(null);
  const revealRef = useRef<(() => void) | null>(null);

  // Click a trap → fly to it, then show the recorder card once the map has
  // settled (spec TM3). Reduced motion jumps instead of flying.
  const focusTrap = useCallback((trap: string, lat: number, lng: number) => {
    const m = mapRef.current;
    if (!m) return;
    if (selectTimer.current) window.clearTimeout(selectTimer.current);
    if (revealRef.current) m.off("moveend", revealRef.current);
    setSelected(null);
    const zoom = Math.min(m.getMaxZoom() || 19, Math.max(m.getZoom() + 1, 18));
    const reveal = () => {
      if (selectTimer.current) window.clearTimeout(selectTimer.current);
      selectTimer.current = null;
      m.off("moveend", reveal);
      revealRef.current = null;
      setSelected(trap);
    };
    revealRef.current = reveal;
    if (prefersReducedMotion()) {
      m.setView([lat, lng], zoom, { animate: false });
      reveal();
      return;
    }
    // Listen only after flyTo starts: stopping an earlier flight fires moveend.
    m.flyTo([lat, lng], zoom, { duration: 0.8 });
    m.once("moveend", reveal);
    // A fly of zero distance may not fire moveend; never leave the click dead.
    selectTimer.current = window.setTimeout(reveal, 1200);
  }, []);

  useEffect(() => () => {
    if (selectTimer.current) window.clearTimeout(selectTimer.current);
  }, []);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (!layerRef.current) layerRef.current = L.layerGroup().addTo(m);
    const layer = layerRef.current;
    layer.clearLayers();
    markersRef.current.clear();
    if (!visibleTraps.length) return;

    const bounds = L.latLngBounds([]);
    const reduced = prefersReducedMotion();
    for (const t of visibleTraps) {
      const pos = trapPosition(t);
      if (!pos) continue;
      const { lat, lng } = pos;
      // Size and pulse carry the severity: both grow with the catch count on
      // a capped log scale (lib/trap-pulse), and a zero-catch trap is a small
      // static dot. Colour says only which pest — the same colour as the
      // legend and everywhere else in SCP (grey for zero).
      const count = t.totalCount || 0;
      const { size } = trapPulse(count);
      const isZero = count <= 0;
      const pestHex = resolvePestColor(t.pest);
      const icon = L.divIcon({
        className: "scp-trap-marker",
        html: trapMarkerHtml({
          key: t.trap,
          count,
          fill: isZero ? "rgba(10,10,10,0.20)" : withAlpha(pestHex, 0.45, "rgba(217,165,20,0.35)"),
          stroke: isZero ? "rgba(10,10,10,0.28)" : withAlpha(pestHex, 0.9, "rgba(217,165,20,0.80)"),
          reducedMotion: reduced,
        }),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
      const marker = L.marker([lat, lng], {
        icon,
        title: `${t.trap} · ${count} catches`,
        keyboard: true,
      });
      marker.on("click", () => focusTrap(t.trap, lat, lng));
      marker.addTo(layer);
      markersRef.current.set(t.trap, marker);
      bounds.extend([lat, lng]);
    }
    if (bounds.isValid()) {
      m.fitBounds(bounds.pad(0.1), { animate: false });
    } else if (mapSettings.lat || mapSettings.lon) {
      // No traps to frame — fall back to the farm/default coordinate so
      // the operator at least sees the right region.
      flyToFarm(
        m,
        mapSettings,
        filters.farm === ALL ? null : filters.farm,
        { animate: false },
      );
    }
  }, [visibleTraps, mapSettings, filters.farm, focusTrap, resolvePestColor]);

  // Off-screen traps hold their pulse; re-checked whenever the view settles.
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    const sync = () => {
      const view = m.getBounds().pad(0.2);
      markersRef.current.forEach((mk) => {
        mk.getElement()?.classList.toggle("scp-trap-offscreen", !view.contains(mk.getLatLng()));
      });
    };
    sync();
    m.on("moveend", sync);
    return () => {
      m.off("moveend", sync);
    };
  }, [visibleTraps]);

  // The selected trap's marker is ringed.
  useEffect(() => {
    markersRef.current.forEach((mk, trap) => {
      mk.getElement()?.classList.toggle("scp-trap-selected", trap === selected);
    });
  }, [selected, visibleTraps]);

  // A trap filtered out of view closes its card.
  const selectedTrap = useMemo(
    () => (selected ? visibleTraps.find((t) => t.trap === selected) ?? null : null),
    [selected, visibleTraps],
  );

  // Fly to the picked farm whenever the operator changes the Farm dropdown.
  // Skips the very first render so the trap-fitBounds above wins on boot.
  const farmFlyMounted = useRef(false);
  useEffect(() => {
    if (!farmFlyMounted.current) {
      farmFlyMounted.current = true;
      // Initial framing — wait for the map to exist, then nudge into place.
      const t = setTimeout(() => {
        flyToFarm(
          mapRef.current,
          mapSettings,
          filters.farm === ALL ? null : filters.farm,
          { animate: false },
        );
      }, 60);
      return () => clearTimeout(t);
    }
    flyToFarm(
      mapRef.current,
      mapSettings,
      filters.farm === ALL ? null : filters.farm,
      { animate: true },
    );
  }, [filters.farm, mapSettings]);

  const totalCatches = visibleTraps.reduce((s, t) => s + t.totalCount, 0);
  const indoorCount = visibleTraps.filter((t) => t.location === "Indoor").length;
  const outdoorCount = visibleTraps.filter((t) => t.location === "Outdoor").length;
  const plottable = visibleTraps.filter((t) => trapPosition(t)).length;
  const noCoordHint = traps.length > 0 && plottable === 0;

  // First load (nothing processed yet): the tabs, pickers, legend and panel
  // titles stand; the counts and the pest rows are skeletons.
  // A failed load ends the skeletons and says so (below), rather than pulsing on.
  const first = firstLoad(loading || (!data && !error), !!data);
  const countOr = (n: number) => (first ? <TextSkeleton width="2ch" /> : n);

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <RangeHeader
        title="Traps"
        subtitle="Per-trap catches · size and pulse = total count · click a trap for its latest reading"
        value={filters}
        onChange={setFilters}
        showFarm={false}
        showGreenhouse={false}
        switcher={
          <Tabs
            value={locFilter}
            onValueChange={(v) => setLocFilter(v as LocationFilter)}
          >
            <TabsList>
              <TabsTrigger value="all">
                All
                <span className="tabular-nums opacity-70">
                  {countOr(visibleTraps.length)}
                </span>
              </TabsTrigger>
              <TabsTrigger value="Indoor">
                Indoor
                <span className="tabular-nums opacity-70">{countOr(indoorCount)}</span>
              </TabsTrigger>
              <TabsTrigger value="Outdoor">
                Outdoor
                <span className="tabular-nums opacity-70">{countOr(outdoorCount)}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
        rightSlot={
          <>
            <MultiPicker
              label="Farms"
              items={farmOptions}
              selected={farmSel ?? new Set(farmOptions)}
              onChange={setFarmSel}
              disabled={first}
            />
            <MultiPicker
              label="Greenhouses"
              items={ghOptions}
              selected={ghSel ?? new Set(ghOptions)}
              onChange={setGhSel}
              disabled={first}
            />
            <MultiPicker
              label="Pests"
              items={pestOptions}
              selected={pestSel ?? new Set(pestOptions)}
              onChange={setPestSel}
              swatch={resolvePestColor}
              count={(p) => pestCounts[p] ?? 0}
              disabled={first}
            />
          </>
        }
      />

      {/* Slim stats line — switcher + filters now live in the header row. */}
      {/* The load's progress sits on the left of this line (was a full-screen
          overlay), so the map and panel stay visible while the weeks load. */}
      <div className="flex items-center justify-between gap-3 px-4 md:px-6 pb-1 text-xs text-muted-foreground tabular-nums">
        {error && !data && !loading && (
          <span role="alert" className="text-destructive">{error}</span>
        )}
        <LoadProgress active={loading} progress={progress} />
      </div>

      {noCoordHint && (
        <div className="px-4 md:px-6 py-1.5 text-[0.7rem] text-amber-700 bg-amber-50 border-b">
          {visibleTraps.length} matching trap
          {visibleTraps.length === 1 ? "" : "s"}, but none have coordinates on
          their scouting entries — nothing to plot in this window.
        </div>
      )}

      <div className="relative flex-1 min-h-[55vh] lg:min-h-0" aria-busy={first || undefined}>
        <div className="absolute inset-4 md:inset-6 isolate z-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <MapBase
            onReady={(m) => {
              mapRef.current = m;
            }}
          />

          <MapKpiPill>
            {first ? (
              <TextSkeleton width="18ch" />
            ) : (
              <>
                {plottable}/{visibleTraps.length} mapped · {totalCatches} catches
              </>
            )}
          </MapKpiPill>

          {/* Pest legend, bottom-right; the trap card takes that corner while open. */}
          {!selectedTrap ? (
          <MapControlPanel
            title="Pests in view"
            count={first ? undefined : pestOptions.length}
            className="bottom-4 left-auto right-4 top-auto"
          >
          {first ? (
            <RowsSkeleton rows={5} />
          ) : pestOptions.length === 0 ? (
            <div className="text-[0.72rem] text-muted-foreground">
              No pest data
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {pestOptions.map((p) => (
                <div
                  key={p}
                  className="flex items-center gap-2 text-[0.72rem] text-foreground/80"
                >
                  <span
                    className="h-3.5 w-3.5 rounded-full border shrink-0"
                    style={{ background: resolvePestColor(p) }}
                  />
                  <span className="flex-1 truncate">{p}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {pestCounts[p] ?? 0}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 pt-2 border-t text-[0.65rem] text-muted-foreground">
            Dot size and pulse show how many were caught.
          </div>
          </MapControlPanel>
          ) : null}

            {selectedTrap ? (
              <TrapReadingCard
                key={selectedTrap.trap}
                trap={selectedTrap.trap}
                from={filters.from}
                to={filters.to}
                local={selectedTrap.latest ?? undefined}
                details={[
                  { label: "Cumulative", value: selectedTrap.totalCount },
                  {
                    label: "Highest",
                    value: selectedTrap.maxCount > 0
                      ? `${selectedTrap.maxCount}${selectedTrap.maxDate ? ` · ${selectedTrap.maxDate}` : ""}`
                      : "0",
                  },
                  { label: "Entries", value: `${selectedTrap.entryCount} · ${selectedTrap.days.size} days` },
                  { label: "House", value: [selectedTrap.greenhouseShort, selectedTrap.zone].filter(Boolean).join(" · ") || "—" },
                  { label: "Location", value: selectedTrap.location || "—" },
                  { label: "Placement", value: placementNote(selectedTrap) },
                ]}
                onClose={() => setSelected(null)}
              />
            ) : null}
        </div>
      </div>

    </div>
  );
}
