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

const KIND_COLOR = {
  pest: "#2BA6E0",
  disease: "#E66BAA",
  trap: "#8466C7",
  empty: "#9ca3af",
} as const;

function entryKind(e: ScoutingEntry): keyof typeof KIND_COLOR {
  if (e.pests_scouting_entry?.length) return "pest";
  if (e.diseases_scouting_entry?.length) return "disease";
  if (e.trap_scouting_entry?.length) return "trap";
  return "empty";
}

function entryHasCoords(e: any): e is ScoutingEntry & {
  latitude: number;
  longitude: number;
} {
  return (
    typeof e?.latitude === "number" &&
    typeof e?.longitude === "number" &&
    Number.isFinite(e.latitude) &&
    Number.isFinite(e.longitude) &&
    Math.abs(e.latitude) > 0.001
  );
}

export function Observations() {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: DEFAULT_CROP,
    farm: ALL,
    greenhouse: ALL,
    ...defaultRange(),
  }));
  const ghForCall = filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop,
  });

  const points = useMemo(() => {
    if (!data) return [];
    // Farm filter is applied client-side because useScouting only takes
    // greenhouse — we narrow further here without re-fetching.
    return data.entries.filter(entryHasCoords);
  }, [data]);

  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  // Render markers whenever the filtered point list changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!layerRef.current) {
      layerRef.current = L.layerGroup().addTo(map);
    }
    const layer = layerRef.current;
    layer.clearLayers();
    if (!points.length) return;

    const bounds = L.latLngBounds([]);
    points.forEach((p) => {
      const lat = (p as any).latitude as number;
      const lng = (p as any).longitude as number;
      const kind = entryKind(p);
      const color = KIND_COLOR[kind];
      const marker = L.circleMarker([lat, lng], {
        radius: 4,
        color: "#ffffff",
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9,
      });
      const obsList: string[] = [];
      p.pests_scouting_entry?.forEach((x) =>
        obsList.push(`Pest · ${x.pest}${x.stage ? ` · ${x.stage}` : ""}`),
      );
      p.diseases_scouting_entry?.forEach((x) =>
        obsList.push(`Disease · ${x.disease}${x.stage ? ` · ${x.stage}` : ""}`),
      );
      p.trap_scouting_entry?.forEach((x) =>
        obsList.push(`Trap · ${x.trap} · ${x.pest || "—"} (${x.count})`),
      );
      const obsHtml = obsList.length
        ? obsList.map((o) => `<li>${o}</li>`).join("")
        : "<li>No observations</li>";
      marker.bindPopup(
        `<div style="font:12px Inter,Arial,sans-serif;color:#374151;min-width:180px">
           <div style="font-weight:600;margin-bottom:2px">${p.greenhouse || p.block || "—"}</div>
           <div style="color:#6b7280;font-size:11px;margin-bottom:6px">${p.zone || p.tree || ""} · ${p.date_of_capture}</div>
           <ul style="padding-left:14px;margin:0">${obsHtml}</ul>
         </div>`,
        { closeButton: false },
      );
      marker.addTo(layer);
      bounds.extend([lat, lng]);
    });
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.1), { animate: false });
    }
  }, [points]);

  // Apply farm filter (we don't have it in useScouting) — narrow points by
  // greenhouse-from-farm map. Cheap because farms stays small.
  const farmFiltered = useMemo(() => {
    if (filters.farm === ALL) return points;
    // We rely on the entry's greenhouse / block name carrying the farm
    // prefix; otherwise fall back to a name-includes match.
    const needle = filters.farm.toLowerCase();
    return points.filter((p) => {
      const wh = (p.greenhouse || p.block || "").toLowerCase();
      return wh.includes(needle);
    });
  }, [points, filters.farm]);

  // Use farm-filtered set when rendering to actually narrow the marker set.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layerRef.current) return;
    layerRef.current.eachLayer((m: any) => {
      const ll = m.getLatLng?.();
      if (!ll) return;
      const found = farmFiltered.find(
        (p: any) => p.latitude === ll.lat && p.longitude === ll.lng,
      );
      m.setStyle?.({ fillOpacity: found ? 0.9 : 0.05 });
    });
  }, [farmFiltered]);

  return (
    <div className="flex flex-col min-h-svh">
      <MapHeader
        title="Observations"
        subtitle="Scouting entries · color-coded by kind"
        value={filters}
        onChange={setFilters}
      />

      <div className="flex-1 flex flex-col">
        <div className="flex items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR.pest }} />
            Pests
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR.disease }} />
            Diseases
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR.trap }} />
            Traps
          </span>
          <span className="ml-auto tabular-nums">
            {farmFiltered.length} / {points.length} points
          </span>
        </div>

        <div className="flex-1 min-h-0">
          <MapBase
            onReady={(map) => {
              mapRef.current = map;
            }}
          />
        </div>
      </div>

      <LoadingStrip active={loading} />
    </div>
  );
}
