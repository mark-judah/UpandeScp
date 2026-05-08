import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { LoadingStrip } from "@/components/LoadingStrip";
import { ALL, MapHeader, type MapFilterValue } from "./maps/MapHeader";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { ymd } from "@/lib/utils";
import type { ScoutingEntry } from "@/lib/scouting-types";

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14);
  return { from: ymd(from), to: ymd(today) };
}

/**
 * Color scale lifted verbatim from traps_map/index.html (getCountColor).
 * Step boundaries kept identical so the legend reads the same as the JS
 * page operators are used to.
 */
const COLOR_STOPS: Array<[number, string, string]> = [
  [0, "#ffffff", "0"],
  [5, "#fef3c7", "1–5"],
  [15, "#fde047", "6–15"],
  [30, "#facc15", "16–30"],
  [50, "#fb923c", "31–50"],
  [75, "#f97316", "51–75"],
  [100, "#dc2626", "76–100"],
  [Infinity, "#7c2d12", "100+"],
];

function colorFor(count: number): string {
  for (const [max, color] of COLOR_STOPS) if (count <= max) return color;
  return COLOR_STOPS[COLOR_STOPS.length - 1][1];
}

interface TrapAgg {
  trap: string;
  pest: string;
  greenhouse: string;
  zone: string;
  location: string;
  totalCount: number;
  entryCount: number;
  days: Set<string>;
  latSum: number;
  lngSum: number;
  latN: number;
}

function entryHasCoords(e: any): boolean {
  return (
    typeof e?.latitude === "number" &&
    typeof e?.longitude === "number" &&
    Number.isFinite(e.latitude) &&
    Number.isFinite(e.longitude) &&
    Math.abs(e.latitude) > 0.001
  );
}

/**
 * Aggregate trap entries the same way the JS page does:
 *   one marker per trap, lat/lng averaged across the entries that touched
 *   it, color scaled by total count.
 *
 * Reads from the IndexedDB cache (via useScouting) — no extra round-trip
 * to the get_trap_data endpoint.
 */
function aggregateTraps(entries: ScoutingEntry[]): TrapAgg[] {
  const map = new Map<string, TrapAgg>();
  for (const e of entries) {
    const lat = (e as any).latitude as number | undefined;
    const lng = (e as any).longitude as number | undefined;
    const hasCoords = entryHasCoords(e);
    for (const t of e.trap_scouting_entry || []) {
      if (!t.trap) continue;
      let agg = map.get(t.trap);
      if (!agg) {
        agg = {
          trap: t.trap,
          pest: t.pest || "—",
          greenhouse: e.greenhouse || e.block || "",
          zone: e.zone || e.tree || "",
          location: t.location || "",
          totalCount: 0,
          entryCount: 0,
          days: new Set(),
          latSum: 0,
          lngSum: 0,
          latN: 0,
        };
        map.set(t.trap, agg);
      }
      agg.totalCount += t.count || 0;
      agg.entryCount += 1;
      if (e.date_of_capture) agg.days.add(e.date_of_capture);
      if (hasCoords && typeof lat === "number" && typeof lng === "number") {
        agg.latSum += lat;
        agg.lngSum += lng;
        agg.latN += 1;
      }
    }
  }
  return Array.from(map.values());
}

type LocationFilter = "all" | "indoor" | "outdoor";

export function TrapsMap() {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: DEFAULT_CROP,
    farm: ALL,
    greenhouse: ALL,
    ...defaultRange(),
  }));
  const [locFilter, setLocFilter] = useState<LocationFilter>("all");
  const ghForCall = filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop,
  });

  const traps = useMemo(
    () => (data ? aggregateTraps(data.entries) : []),
    [data],
  );

  const visibleTraps = useMemo(() => {
    return traps.filter((t) => {
      if (locFilter === "indoor" && !/indoor/i.test(t.location)) return false;
      if (locFilter === "outdoor" && !/outdoor/i.test(t.location)) return false;
      if (filters.farm !== ALL) {
        if (!t.greenhouse.toLowerCase().includes(filters.farm.toLowerCase()))
          return false;
      }
      return true;
    });
  }, [traps, filters.farm, locFilter]);

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
      const color = colorFor(t.totalCount);

      const html = `
        <div style="
          width:34px;height:34px;border-radius:50%;
          background:${color};
          border:2px solid #ffffff;
          box-shadow:0 1px 3px rgba(0,0,0,0.3);
          display:flex;align-items:center;justify-content:center;
          font:600 12px Inter,Arial,sans-serif;
          color:${t.totalCount > 30 ? "#ffffff" : "#374151"};
        ">${t.totalCount}</div>`;
      const icon = L.divIcon({
        className: "scp-trap-marker",
        html,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const marker = L.marker([lat, lng], { icon });
      marker.bindPopup(
        `<div style="font:12px Inter,Arial,sans-serif;color:#374151;min-width:200px">
           <div style="font-weight:600;margin-bottom:2px">${t.trap}</div>
           <div style="color:#6b7280;font-size:11px;margin-bottom:6px">
             ${t.pest} · ${t.location || "—"}
           </div>
           <table style="font-size:11px;border-collapse:collapse;width:100%">
             <tr><td style="padding:1px 4px;color:#6b7280">Total catches</td><td style="text-align:right;font-weight:600">${t.totalCount}</td></tr>
             <tr><td style="padding:1px 4px;color:#6b7280">Entries</td><td style="text-align:right">${t.entryCount}</td></tr>
             <tr><td style="padding:1px 4px;color:#6b7280">Days recorded</td><td style="text-align:right">${t.days.size}</td></tr>
             <tr><td style="padding:1px 4px;color:#6b7280">Greenhouse</td><td style="text-align:right">${t.greenhouse}</td></tr>
             <tr><td style="padding:1px 4px;color:#6b7280">Zone</td><td style="text-align:right">${t.zone || "—"}</td></tr>
           </table>
         </div>`,
        { closeButton: false },
      );
      marker.addTo(layer);
      bounds.extend([lat, lng]);
    }
    if (bounds.isValid()) m.fitBounds(bounds.pad(0.1), { animate: false });
  }, [visibleTraps]);

  const totalCatches = visibleTraps.reduce((s, t) => s + t.totalCount, 0);
  const indoorCount = visibleTraps.filter((t) => /indoor/i.test(t.location)).length;
  const outdoorCount = visibleTraps.filter((t) => /outdoor/i.test(t.location)).length;

  return (
    <div className="flex flex-col min-h-svh">
      <MapHeader
        title="Traps"
        subtitle="Per-trap catches · color = total count"
        value={filters}
        onChange={setFilters}
      />

      <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b">
        <div className="flex items-center gap-1 rounded-md border bg-card p-0.5">
          {(
            [
              ["all", `All · ${visibleTraps.length}`],
              ["indoor", `Indoor · ${indoorCount}`],
              ["outdoor", `Outdoor · ${outdoorCount}`],
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

        <span className="ml-auto flex items-center gap-1.5">
          {COLOR_STOPS.map(([, color, label]) => (
            <span key={label} className="flex items-center gap-1">
              <span
                className="h-2.5 w-4 rounded border"
                style={{ background: color }}
              />
              <span className="tabular-nums">{label}</span>
            </span>
          ))}
        </span>
        <span className="tabular-nums">total {totalCatches}</span>
      </div>

      <div className="flex-1 min-h-0">
        <MapBase
          onReady={(m) => {
            mapRef.current = m;
          }}
        />
      </div>

      <LoadingStrip active={loading} />
    </div>
  );
}
