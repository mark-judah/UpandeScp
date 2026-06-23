/**
 * Observations map — port of upande_scp/www/observations_map/index.html.
 *
 * Single-day view of scouting activity for one crop/farm/greenhouse:
 * each scouted zone is rendered as a closed polygon filled with the
 * canonical pest / disease colour of the dominant observation under the
 * active kind. No range — picking a date range layered multiple days'
 * worth of observations into one polygon and turned the map into noise.
 *
 * Reads only from the IDB-cached scouting payload and the IDB-cached
 * bed/zone GeoJSON (warmed on app boot). The leaflet container sits in
 * its own ``isolate z-0`` stacking context so the date-picker popover
 * always paints above the map.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ALL,
  RangeHeader,
  type RangeFilterValue,
} from "./maps/RangeHeader";
import { fetchBedsAndZones } from "@/lib/scouting-api";
import { flyToFarm, useMapSettings } from "@/hooks/use-map-settings";
import { useObservationColors } from "@/lib/observation-colors";
import { currentWeekRange } from "@/lib/utils";
import {
  flattenZones,
  type ZoneFeature,
} from "./maps/zone-utils";
import type { ScoutingEntry } from "@/lib/scouting-types";

type Kind = "pest" | "disease" | "trap";

const KIND_LABEL: Record<Kind, string> = {
  pest: "Pests",
  disease: "Diseases",
  trap: "Traps",
};

const KIND_FALLBACK: Record<Kind, string> = {
  pest: "#2BA6E0",
  disease: "#E66BAA",
  trap: "#8466C7",
};

function ghOf(zoneOrBed: string): string {
  const i = zoneOrBed.indexOf(" - Bed ");
  return i >= 0 ? zoneOrBed.slice(0, i) : zoneOrBed.split(" - ")[0];
}

/** Ordered observation names of the requested kind on a single entry. */
function namesForKind(e: ScoutingEntry, kind: Kind): string[] {
  if (kind === "pest")
    return (e.pests_scouting_entry || [])
      .map((p) => p.pest)
      .filter(Boolean) as string[];
  if (kind === "disease")
    return (e.diseases_scouting_entry || [])
      .map((d) => d.disease)
      .filter(Boolean) as string[];
  return (e.trap_scouting_entry || [])
    .map((t) => t.pest)
    .filter(Boolean) as string[];
}

/** Map intensity (count / max) → fill opacity. Mirrors the legacy
 *  ``intensityToOpacity`` helper. */
function intensityToOpacity(count: number, maxCount: number): number {
  if (!count || !maxCount) return 0;
  return 0.15 + (count / maxCount) * 0.75;
}

export function Observations({ initialCrop }: { initialCrop?: string } = {}) {
  const [filters, setFilters] = useState<RangeFilterValue>(() => ({
    crop: initialCrop ?? "Rose",
    farm: ALL,
    greenhouse: ALL,
    ...currentWeekRange(),
  }));
  const isSingleDay = filters.from === filters.to;
  const [kind, setKind] = useState<Kind>("pest");
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // Single-day query: from === to. The IDB cache is day-precise, so this
  // is a single-day slice of an already-resident dataset.
  const ghForCall =
    filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading, progress, weeksLoaded, weeksTotal } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop,
  });

  const { pest: pestColor, disease: diseaseColor } = useObservationColors();
  const mapSettings = useMapSettings();
  const resolveColor = (name: string): string =>
    kind === "disease" ? diseaseColor(name) : pestColor(name);

  // Reset legend selection when the kind toggles.
  useEffect(() => {
    setHidden(new Set());
  }, [kind]);

  // Geometry — IDB-cached on app boot, near-instant.
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);

  const farmNeedle = filters.farm === ALL ? "" : filters.farm.toLowerCase();
  const inFarm = (e: ScoutingEntry) => {
    if (!farmNeedle) return true;
    return (e.greenhouse || e.block || "")
      .toLowerCase()
      .includes(farmNeedle);
  };

  // Entries to consider — single day, filtered by farm.
  const dayEntries = useMemo(() => {
    if (!data) return [];
    return data.entries.filter(
      (e) =>
        !!e.date_of_capture &&
        e.date_of_capture >= filters.from &&
        e.date_of_capture <= filters.to &&
        inFarm(e),
    );
  }, [data, filters.from, filters.to, farmNeedle]);

  // Per-zone observation map: zone -> { name -> count } under the active kind.
  const zoneObs = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const e of dayEntries) {
      if (!e.zone) continue;
      const list =
        kind === "pest"
          ? e.pests_scouting_entry
          : kind === "disease"
            ? e.diseases_scouting_entry
            : e.trap_scouting_entry;
      if (!list?.length) continue;
      for (const o of list as any[]) {
        const name = kind === "disease" ? o.disease : o.pest;
        if (!name) continue;
        const c = Number(o.count) > 0 ? Number(o.count) : 1;
        if (!out[e.zone]) out[e.zone] = {};
        out[e.zone][name] = (out[e.zone][name] || 0) + c;
      }
    }
    return out;
  }, [dayEntries, kind]);

  // Per-zone visible totals (after the legend hide-set is applied).
  const zoneTotals = useMemo(() => {
    const out = new Map<string, number>();
    Object.entries(zoneObs).forEach(([zone, items]) => {
      let total = 0;
      Object.entries(items).forEach(([name, c]) => {
        if (!hidden.has(name)) total += c;
      });
      if (total > 0) out.set(zone, total);
    });
    return out;
  }, [zoneObs, hidden]);

  const maxIntensity = useMemo(() => {
    let m = 1;
    zoneTotals.forEach((v) => {
      if (v > m) m = v;
    });
    return m;
  }, [zoneTotals]);

  // Legend rows: count per observation name across the day.
  const legendRows = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.values(zoneObs).forEach((items) =>
      Object.entries(items).forEach(([name, c]) => {
        counts[name] = (counts[name] || 0) + c;
      }),
    );
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [zoneObs]);

  // KPIs (Zones, Beds, Scouts, Entries) — restricted to the visible kind.
  const stats = useMemo(() => {
    const zonesSet = new Set<string>();
    const beds = new Set<string>();
    const scouts = new Set<string>();
    let entries = 0;
    for (const e of dayEntries) {
      const names = namesForKind(e, kind);
      if (!names.length) continue;
      if (!names.some((n) => !hidden.has(n))) continue;
      if (e.zone) zonesSet.add(e.zone);
      if (e.bed) beds.add(e.bed);
      if (e.scouts_name) scouts.add(e.scouts_name);
      entries += 1;
    }
    return {
      zones: zonesSet.size,
      beds: beds.size,
      scouts: scouts.size,
      entries,
    };
  }, [dayEntries, kind, hidden]);

  // ── Map rendering ────────────────────────────────────────────────────
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  // Index zones by name for O(1) lookup; only zones present in the day's
  // entries actually get drawn.
  const zoneByName = useMemo(() => {
    const m = new Map<string, ZoneFeature>();
    for (const z of zones) m.set(z.zoneName, z);
    return m;
  }, [zones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!layerRef.current) layerRef.current = L.layerGroup().addTo(map);
    const layer = layerRef.current;
    layer.clearLayers();

    if (!zoneTotals.size) return;

    const bounds = L.latLngBounds([]);
    zoneTotals.forEach((total, zoneName) => {
      const z = zoneByName.get(zoneName);
      if (!z?.geometry) return;
      // Restrict by greenhouse selector.
      if (
        filters.greenhouse !== ALL &&
        !z.bedName.startsWith(filters.greenhouse)
      ) {
        return;
      }

      // Dominant visible observation in this zone → its canonical colour.
      const items = zoneObs[zoneName] || {};
      const visible = Object.entries(items).filter(
        ([n]) => !hidden.has(n),
      );
      if (!visible.length) return;
      visible.sort((a, b) => b[1] - a[1]);
      const dominantName = visible[0][0];
      const fill = resolveColor(dominantName) || KIND_FALLBACK[kind];
      const op = intensityToOpacity(total, maxIntensity);
      // Stroke weight scales with intensity so heavy infestations read
      // visually heavier even at low zoom (where polygon fill is too
      // small to see). Mirrors what the legacy page achieved by zooming
      // its zone fill in/out.
      const weight = 4 + Math.round(op * 8); // 4 → 12 px

      // Render the zone's actual FeatureCollection (one LineString per
      // bed-line) directly. This is more robust than synthesising a
      // single Polygon from disjoint bed lines, which produced a
      // degenerate ring on multi-block greenhouses and rendered
      // invisibly in some farms.
      const layerObj = L.geoJSON(z.geometry as any, {
        style: () => ({
          color: fill,
          weight,
          opacity: 0.95,
          // For any actual polygon features in the geometry, fill in
          // the dominant colour at the intensity-scaled opacity.
          fillColor: fill,
          fillOpacity: op,
        }),
      });

      const popupRows = visible
        .map(
          ([n, c]) =>
            `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
               <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${resolveColor(n)};border:1px solid #fff"></span>
               <span style="flex:1">${n}</span>
               <span style="font-variant-numeric:tabular-nums;color:#6b7280">×${c}</span>
             </div>`,
        )
        .join("");
      layerObj.bindPopup(
        `<div style="font:12px Inter,Arial,sans-serif;color:#374151;min-width:220px">
           <div style="font-weight:600;margin-bottom:4px">${zoneName}</div>
           <div style="color:#6b7280;font-size:11px;margin-bottom:6px">
             ${KIND_LABEL[kind]} · ${total} observation${total === 1 ? "" : "s"}
           </div>
           ${popupRows}
         </div>`,
        { closeButton: false },
      );
      layerObj.bindTooltip(zoneName, { sticky: true });
      layerObj.addTo(layer);
      try {
        bounds.extend(layerObj.getBounds());
      } catch {
        /* skip empty */
      }
    });

    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.08), { animate: false });
    } else if (mapSettings.lat || mapSettings.lon) {
      flyToFarm(
        map,
        mapSettings,
        filters.farm === ALL ? null : filters.farm,
        { animate: false },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneTotals, zoneByName, kind, maxIntensity, filters.greenhouse, mapSettings, filters.farm]);

  // Fly-to whenever the Farm dropdown changes, using the per-farm
  // coordinates from the Map Settings doctype.
  const farmFlyMounted = useRef(false);
  useEffect(() => {
    if (!farmFlyMounted.current) {
      farmFlyMounted.current = true;
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

  const toggleName = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="flex flex-col min-h-svh">
      <RangeHeader
        title="Observations"
        subtitle="Scouted zones · up to one week · canonical pest / disease colour"
        value={filters}
        onChange={setFilters}
        showCrop={false}
      />

      {/* Kind pills with live observation counts. */}
      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b bg-card/50">
        <div className="flex items-center gap-0.5 rounded-md border bg-card p-0.5">
          {(["pest", "disease", "trap"] as Kind[]).map((k) => {
            const total = dayEntries.reduce(
              (s, e) => s + namesForKind(e, k).length,
              0,
            );
            return (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`px-2.5 py-1 rounded text-[0.7rem] transition-colors flex items-center gap-1.5 ${
                  kind === k
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full border"
                  style={{ background: KIND_FALLBACK[k] }}
                  aria-hidden
                />
                {KIND_LABEL[k]}
                <span className="text-[0.65rem] tabular-nums opacity-80">
                  {total}
                </span>
              </button>
            );
          })}
        </div>
        <span className="ml-auto tabular-nums">
          {zoneTotals.size} scouted zone{zoneTotals.size === 1 ? "" : "s"}
        </span>
      </div>

      {/* Map + floating panel. ``isolate z-0`` keeps the leaflet panes
          (z-index up to 700 internally) inside this stacking context so
          the date-picker popover (z-50, portaled to body) always paints
          above the map. */}
      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0 isolate z-0">
          <MapBase
            onReady={(m) => {
              mapRef.current = m;
            }}
          />
        </div>

        <Card className="absolute bottom-4 right-4 z-10 w-72 max-h-[70vh] overflow-y-auto bg-card/95 backdrop-blur shadow-md p-3">
          <CardHeader className="p-0 pb-2">
            <CardTitle className="text-sm">{KIND_LABEL[kind]} summary</CardTitle>
            <CardDescription className="text-[0.7rem] tabular-nums">
              {isSingleDay ? filters.from : `${filters.from} → ${filters.to}`}
            </CardDescription>
          </CardHeader>

          <div className="grid grid-cols-4 gap-2 mb-3">
            {[
              ["Zones", stats.zones],
              ["Beds", stats.beds],
              ["Scouts", stats.scouts],
              ["Entries", stats.entries],
            ].map(([label, v]) => (
              <div
                key={label as string}
                className="rounded border bg-[var(--sd-bg-soft)] px-1.5 py-1 text-center"
              >
                <div className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                  {label}
                </div>
                <div className="text-sm font-semibold tabular-nums">{v}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[0.7rem] uppercase tracking-wide font-semibold text-muted-foreground">
              Legend
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="text-[0.65rem] px-2 py-0.5 rounded border bg-card hover:bg-muted"
                onClick={() => setHidden(new Set())}
              >
                All
              </button>
              <button
                type="button"
                className="text-[0.65rem] px-2 py-0.5 rounded border bg-card hover:bg-muted"
                onClick={() =>
                  setHidden(new Set(legendRows.map((r) => r.name)))
                }
              >
                None
              </button>
            </div>
          </div>

          {legendRows.length === 0 ? (
            <div className="text-[0.72rem] text-muted-foreground py-3 text-center">
              No {KIND_LABEL[kind].toLowerCase()} in this range.
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {legendRows.map((r) => {
                const off = hidden.has(r.name);
                return (
                  <label
                    key={r.name}
                    className={`flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted cursor-pointer transition-opacity ${off ? "opacity-50" : ""}`}
                  >
                    <Checkbox
                      checked={!off}
                      onCheckedChange={() => toggleName(r.name)}
                    />
                    <span
                      className="h-3 w-3 rounded-full border shrink-0"
                      style={{ background: resolveColor(r.name) }}
                      aria-hidden
                    />
                    <span className="text-[0.72rem] flex-1 truncate">
                      {r.name}
                    </span>
                    <span className="text-[0.65rem] tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {r.count}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </Card>
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
