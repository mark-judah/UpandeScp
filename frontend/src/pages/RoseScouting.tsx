import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { LoadingStrip } from "@/components/LoadingStrip";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ALL, MapHeader, type MapFilterValue } from "./maps/MapHeader";
import { fetchBedsAndZones, DEFAULT_CROP } from "@/lib/scouting-api";
import { ymd } from "@/lib/utils";
import { flattenZones, type ZoneFeature } from "./maps/zone-utils";

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14);
  return { from: ymd(from), to: ymd(today) };
}

interface ZoneAggregate {
  zone: string;
  pests: Record<string, number>;
  diseases: Record<string, number>;
  scouts: number;
}

export function RoseScouting() {
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: "Rose",
    farm: ALL,
    greenhouse: ALL,
    ...defaultRange(),
  }));
  const ghForCall = filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop || DEFAULT_CROP,
  });
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);

  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);

  // Per-zone aggregate of pests + diseases (for the side panel).
  const aggByZone = useMemo(() => {
    const out = new Map<string, ZoneAggregate>();
    if (!data) return out;
    for (const e of data.entries) {
      const zone = e.zone;
      if (!zone) continue;
      let row = out.get(zone);
      if (!row) {
        row = { zone, pests: {}, diseases: {}, scouts: 0 };
        out.set(zone, row);
      }
      e.pests_scouting_entry.forEach((p) => {
        row!.pests[p.pest] = (row!.pests[p.pest] || 0) + (p.count || 1);
      });
      e.diseases_scouting_entry.forEach((d) => {
        row!.diseases[d.disease] = (row!.diseases[d.disease] || 0) + 1;
      });
      if (e.scouts_name) row.scouts += 1;
    }
    return out;
  }, [data]);

  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (!layerRef.current) layerRef.current = L.layerGroup().addTo(m);
    const layer = layerRef.current;
    layer.clearLayers();
    if (!zones.length) return;

    const bounds = L.latLngBounds([]);
    let plotted = 0;
    for (const z of zones) {
      if (!z.geometry) continue;
      if (
        filters.greenhouse !== ALL &&
        !z.bedName.startsWith(filters.greenhouse)
      )
        continue;
      const agg = aggByZone.get(z.zoneName);
      const obs =
        Object.values(agg?.pests || {}).reduce((s, v) => s + v, 0) +
        Object.values(agg?.diseases || {}).reduce((s, v) => s + v, 0);
      const layerObj = L.geoJSON(z.geometry, {
        style: () => ({
          color: "#4b5563",
          weight: 0.5,
          opacity: 0.8,
          fillColor: obs > 0 ? "#5BB45D" : "#f3f4f6",
          fillOpacity: obs > 0 ? 0.55 : 0.2,
        }),
      });
      layerObj.on("click", () => setSelectedZone(z.zoneName));
      layerObj.bindTooltip(
        `<div style="font:11px Inter,Arial,sans-serif">
           <b>${z.zoneName}</b><br/>${obs} observation${obs !== 1 ? "s" : ""}
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
  }, [zones, aggByZone, filters.greenhouse]);

  const detail = selectedZone ? aggByZone.get(selectedZone) : null;
  const topPests = detail
    ? Object.entries(detail.pests).sort(([, a], [, b]) => b - a).slice(0, 5)
    : [];
  const topDiseases = detail
    ? Object.entries(detail.diseases).sort(([, a], [, b]) => b - a).slice(0, 5)
    : [];

  return (
    <div className="flex flex-col min-h-svh">
      <MapHeader
        title="Rose Scouting"
        subtitle="Zone-level breakdown · click a zone for details"
        value={filters}
        onChange={setFilters}
      />

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_1fr]">
        <div className="relative">
          <MapBase
            onReady={(m) => {
              mapRef.current = m;
            }}
          />
        </div>

        <div className="border-l bg-card p-3 overflow-auto">
          {detail ? (
            <Card className="p-3 shadow-none border-0">
              <CardHeader className="p-0 pb-2">
                <CardTitle>{detail.zone}</CardTitle>
                <CardDescription>
                  {detail.scouts} entr{detail.scouts !== 1 ? "ies" : "y"} ·
                  {" "}
                  {topPests.length + topDiseases.length} observation
                  {topPests.length + topDiseases.length !== 1 ? "s" : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 flex flex-col gap-3">
                <div>
                  <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                    Top Pests
                  </div>
                  {topPests.length ? (
                    topPests.map(([name, count]) => (
                      <div
                        key={name}
                        className="flex justify-between text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)] mb-1"
                      >
                        <span className="truncate">{name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {count}
                        </span>
                      </div>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">None</span>
                  )}
                </div>
                <div>
                  <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                    Top Diseases
                  </div>
                  {topDiseases.length ? (
                    topDiseases.map(([name, count]) => (
                      <div
                        key={name}
                        className="flex justify-between text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)] mb-1"
                      >
                        <span className="truncate">{name}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {count}
                        </span>
                      </div>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">None</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="p-4">
              <CardHeader className="p-0">
                <CardTitle>Pick a zone</CardTitle>
                <CardDescription>
                  Click any colored zone on the map to see its scouting roll-up.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 mt-3">
                <Badge variant="outline" className="text-[0.65rem]">
                  {zones.length} zones loaded
                </Badge>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <LoadingStrip active={loading} />
    </div>
  );
}
