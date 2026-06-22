import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { ChevronDown } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ALL, RangeHeader, type RangeFilterValue } from "./maps/RangeHeader";
import { DEFAULT_CROP, fetchFarmsAndWarehouses } from "@/lib/scouting-api";
import { flyToFarm, useMapSettings } from "@/hooks/use-map-settings";
import {
  pestColor,
  readableInk,
  useObservationColors,
} from "@/lib/observation-colors";
import { currentWeekRange } from "@/lib/utils";
import type { ScoutingEntry } from "@/lib/scouting-types";


/** Severity ramp — used as a thin outer ring on each trap marker so the
 *  pest colour reads as the primary signal but operators still see catch
 *  intensity at a glance. Stops match the original HTML page. */
const SEVERITY_STOPS: Array<[number, string, string, string]> = [
  [0, "#e5e7eb", "0", "No catches"],
  [5, "#fde68a", "1–5", "Very low"],
  [15, "#fcd34d", "6–15", "Low"],
  [30, "#facc15", "16–30", "Moderate"],
  [50, "#fb923c", "31–50", "Elevated"],
  [75, "#f97316", "51–75", "High"],
  [100, "#dc2626", "76–100", "Very high"],
  [Infinity, "#7c2d12", "100+", "Critical"],
];

function severityColor(count: number): string {
  for (const [max, color] of SEVERITY_STOPS) if (count <= max) return color;
  return SEVERITY_STOPS[SEVERITY_STOPS.length - 1][1];
}

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

const ghShort = (gh: string) =>
  gh ? gh.split(" - ")[0] : "";

function aggregateTraps(entries: ScoutingEntry[]): TrapAgg[] {
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
          greenhouseShort: ghShort(fullGh),
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
        };
        map.set(key, agg);
      }
      const c = t.count || 0;
      agg.totalCount += c;
      if (c > agg.maxCount) {
        agg.maxCount = c;
        agg.maxDate = e.date_of_capture || "";
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

type LocationFilter = "all" | "Indoor" | "Outdoor";

interface MultiPickerProps {
  label: string;
  items: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  swatch?: (item: string) => string | undefined;
  count?: (item: string) => number | undefined;
}

function MultiPicker({
  label,
  items,
  selected,
  onChange,
  swatch,
  count,
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
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 font-normal text-[0.72rem]"
        >
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
    fetchFarmsAndWarehouses()
      .then((farms) => {
        if (cancelled) return;
        const out: Record<string, string> = {};
        Object.entries(farms).forEach(([farm, ghs]) => {
          (ghs || []).forEach((g) => {
            out[g] = farm;
            // Pickers compare on the short greenhouse code (split on " - ").
            const short = ghShort(g);
            if (short && !out[short]) out[short] = farm;
          });
        });
        setGhToFarm(out);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const ghForCall = filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading, progress, weeksLoaded, weeksTotal } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop,
  });

  const traps = useMemo(
    () => (data ? aggregateTraps(data.entries) : []),
    [data],
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
  // just that farm; switching back to "All Farms" restores everything.
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

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (!layerRef.current) layerRef.current = L.layerGroup().addTo(m);
    const layer = layerRef.current;
    layer.clearLayers();
    if (!visibleTraps.length) return;

    const bounds = L.latLngBounds([]);
    for (const t of visibleTraps) {
      if (t.latN === 0) continue;
      const lat = t.latSum / t.latN;
      const lng = t.lngSum / t.latN;
      // Marker visual: pest colour fills the disc (canonical key from the
      // doctype), the ring around it carries the severity colour so the
      // operator still reads catch intensity at a glance.
      const fill = resolvePestColor(t.pest);
      const ring = severityColor(t.totalCount);
      const ink = readableInk(fill);

      const html = `
        <div style="
          width:34px;height:34px;border-radius:50%;
          background:${fill};
          border:3px solid ${ring};
          box-shadow:0 1px 3px rgba(0,0,0,0.25);
          display:flex;align-items:center;justify-content:center;
          font:700 12px Inter,Arial,sans-serif;
          color:${ink};
        ">${t.totalCount}</div>`;
      const icon = L.divIcon({
        className: "scp-trap-marker",
        html,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const marker = L.marker([lat, lng], { icon });
      const peakLine = t.maxCount > 0
        ? `${t.maxCount}${t.maxDate ? ` <span style="color:#9ca3af">on ${t.maxDate}</span>` : ""}`
        : "0";
      marker.bindPopup(
        `<div style="font:12px Inter,Arial,sans-serif;color:#374151;min-width:230px">
           <div style="font-weight:700;font-size:13px;margin-bottom:6px;color:#111827">${t.trap}</div>
           <div style="display:grid;gap:3px;font-size:11.5px">
             <div><span style="color:#6b7280">Pest:</span> <strong>${t.pest || "—"}</strong></div>
             <div><span style="color:#6b7280">Cumulative catches:</span> <strong>${t.totalCount}</strong></div>
             <div><span style="color:#6b7280">Highest single count:</span> <strong>${peakLine}</strong></div>
             <div><span style="color:#6b7280">Entries:</span> ${t.entryCount} · <span style="color:#6b7280">days:</span> ${t.days.size}</div>
             <div><span style="color:#6b7280">Location:</span> ${t.location || "—"}</div>
             <div style="margin-top:3px;padding-top:3px;border-top:1px solid #f3f4f6">
               <div><span style="color:#6b7280">Greenhouse:</span> ${t.greenhouseShort || "—"}</div>
               <div><span style="color:#6b7280">Zone:</span> ${t.zone || "—"}</div>
               <div style="color:#9ca3af;font-size:10.5px;margin-top:2px">
                 Marker at avg of ${t.latN} entr${t.latN === 1 ? "y" : "ies"}
               </div>
             </div>
           </div>
         </div>`,
        { closeButton: false },
      );
      marker.addTo(layer);
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
  }, [visibleTraps, mapSettings, filters.farm]);

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
  const plottable = visibleTraps.filter((t) => t.latN > 0).length;
  const noCoordHint = traps.length > 0 && plottable === 0;

  return (
    <div className="flex flex-col min-h-svh">
      <RangeHeader
        title="Traps"
        subtitle="Per-trap catches · up to one week · color = total count"
        value={filters}
        onChange={setFilters}
        showCrop={false}
      />

      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b bg-card/50">
        <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5">
          {(
            [
              ["all", `All · ${visibleTraps.length}`],
              ["Indoor", `Indoor · ${indoorCount}`],
              ["Outdoor", `Outdoor · ${outdoorCount}`],
            ] as Array<[LocationFilter, string]>
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setLocFilter(k)}
              className={`px-2.5 py-1 rounded text-[0.7rem] transition-colors ${
                locFilter === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <MultiPicker
          label="Farms"
          items={farmOptions}
          selected={farmSel ?? new Set(farmOptions)}
          onChange={setFarmSel}
        />
        <MultiPicker
          label="Greenhouses"
          items={ghOptions}
          selected={ghSel ?? new Set(ghOptions)}
          onChange={setGhSel}
        />
        <MultiPicker
          label="Pests"
          items={pestOptions}
          selected={pestSel ?? new Set(pestOptions)}
          onChange={setPestSel}
          swatch={resolvePestColor}
          count={(p) => pestCounts[p] ?? 0}
        />

        <span className="ml-auto tabular-nums">
          {plottable}/{visibleTraps.length} mapped · {totalCatches} catches
        </span>
      </div>

      {noCoordHint && (
        <div className="px-4 md:px-6 py-1.5 text-[0.7rem] text-amber-700 bg-amber-50 border-b">
          {visibleTraps.length} matching trap
          {visibleTraps.length === 1 ? "" : "s"}, but none have coordinates on
          their scouting entries — nothing to plot in this window.
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 isolate z-0">
          <MapBase
            onReady={(m) => {
              mapRef.current = m;
            }}
          />
        </div>

        <div className="absolute bottom-4 right-4 z-10 rounded-lg border bg-card/95 backdrop-blur shadow-md p-3 w-60">
          <div className="text-[0.7rem] uppercase tracking-wide font-semibold text-muted-foreground mb-2">
            Pests in view
          </div>
          {pestOptions.length === 0 ? (
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
          <div className="mt-3 pt-2 border-t">
            <div className="text-[0.65rem] uppercase tracking-wide font-semibold text-muted-foreground mb-1.5">
              Severity ring
            </div>
            <div className="flex flex-wrap gap-1">
              {SEVERITY_STOPS.map(([, color, range]) => (
                <span
                  key={range}
                  className="inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground"
                  title={range}
                >
                  <span
                    className="h-2 w-2 rounded-full border"
                    style={{ background: color }}
                  />
                  {range}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <LoadingOverlay
        open={loading}
        progress={progress}
        weeksLoaded={weeksLoaded}
        weeksTotal={weeksTotal}
      />
    </div>
  );
}
