import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapBase } from "@/components/MapBase";
import { LoadingStrip } from "@/components/LoadingStrip";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
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
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="h-6" />
        <div>
          <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
            Varieties
          </h1>
          <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
            Zones colored by variety
          </p>
        </div>
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {varietyList.length} varieties · {zones.length} zones
        </div>
      </header>

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
