import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapBase } from "@/components/MapBase";
import { LoadingStrip } from "@/components/LoadingStrip";
import { PageHeader } from "@/components/PageHeader";
import { fetchBedsAndZones } from "@/lib/scouting-api";
import { flattenZones, type ZoneFeature } from "./maps/zone-utils";

const PALETTE = [
  "#2BA6E0",
  "#E66BAA",
  "#8466C7",
  "#E9A23B",
  "#5BB45D",
  "#3D54B0",
  "#E63946",
  "#10b981",
  "#f97316",
  "#a855f7",
];

function colorByVariety(varieties: string[]): Map<string, string> {
  const map = new Map<string, string>();
  varieties.forEach((v, i) => map.set(v, PALETTE[i % PALETTE.length]));
  return map;
}

export function Varieties() {
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBedsAndZones()
      .then((vs) => setZones(flattenZones(vs)))
      .finally(() => setLoading(false));
  }, []);

  const varietyList = useMemo(() => {
    const set = new Set<string>();
    zones.forEach((z) => z.variety && set.add(z.variety));
    return Array.from(set).sort();
  }, [zones]);

  const varietyColor = useMemo(() => colorByVariety(varietyList), [varietyList]);

  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (!layerRef.current) layerRef.current = L.layerGroup().addTo(m);
    const layer = layerRef.current;
    layer.clearLayers();

    const bounds = L.latLngBounds([]);
    let plotted = 0;
    for (const z of zones) {
      if (!z.geometry) continue;
      const fill = varietyColor.get(z.variety) || "#9ca3af";
      const layerObj = L.geoJSON(z.geometry, {
        style: () => ({
          color: "#374151",
          weight: 0.4,
          opacity: 0.7,
          fillColor: fill,
          fillOpacity: 0.6,
        }),
      });
      layerObj.bindTooltip(
        `<div style="font:11px Inter,Arial,sans-serif">
           <b>${z.variety || "Unknown"}</b><br/>${z.zoneName}
         </div>`,
        { sticky: true },
      );
      layerObj.addTo(layer);
      plotted++;
      try {
        bounds.extend(layerObj.getBounds());
      } catch {
        /* skip */
      }
    }
    if (plotted && bounds.isValid())
      m.fitBounds(bounds.pad(0.05), { animate: false });
  }, [zones, varietyColor]);

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <PageHeader title="Varieties" eyebrow="Zones colored by variety">
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {varietyList.length} varieties · {zones.length} zones
        </div>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6 py-2 text-xs border-b">
        {varietyList.map((v) => (
          <span key={v} className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: varietyColor.get(v) }}
            />
            <span className="text-muted-foreground">{v}</span>
          </span>
        ))}
      </div>

      <div className="flex-1 min-h-0 px-4 pb-4 md:px-6 md:pb-6">
        <MapBase
          className="overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]"
          onReady={(m) => {
            mapRef.current = m;
          }}
        />
      </div>

      <LoadingStrip active={loading} />
    </div>
  );
}
