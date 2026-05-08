import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { LoadingStrip } from "@/components/LoadingStrip";
import { ALL, MapHeader, type MapFilterValue } from "./maps/MapHeader";
import { DashFilterRow } from "./dashboard/DashFilterRow";
import {
  ALL_FILTER,
  pestFilterOptions,
  diseaseFilterOptions,
  type DashFilters,
} from "./dashboard/aggregate";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { fetchBedsAndZones, DEFAULT_CROP } from "@/lib/scouting-api";
import { ymd } from "@/lib/utils";
import { flattenZones, type ZoneFeature } from "./maps/zone-utils";

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14);
  return { from: ymd(from), to: ymd(today) };
}

type Mode = "pest" | "disease";

const FILL_RAMP = [
  "#fafbfc",
  "#fde7eb",
  "#fbc1cb",
  "#f58fa2",
  "#ec5878",
  "#dc2f53",
  "#b71c44",
];

function fillFor(intensity: number): string {
  // intensity in 0..1 → ramp index
  const idx = Math.min(
    FILL_RAMP.length - 1,
    Math.max(0, Math.round(intensity * (FILL_RAMP.length - 1))),
  );
  return FILL_RAMP[idx];
}

export function Heatmaps() {
  const [mode, setMode] = useState<Mode>("pest");
  const [filters, setFilters] = useState<MapFilterValue>(() => ({
    crop: DEFAULT_CROP,
    farm: ALL,
    greenhouse: ALL,
    ...defaultRange(),
  }));
  const [obsFilters, setObsFilters] = useState<DashFilters>({
    observation: ALL_FILTER,
    section: ALL_FILTER,
    stage: ALL_FILTER,
  });
  const [zones, setZones] = useState<ZoneFeature[]>([]);

  const ghForCall = filters.greenhouse === ALL ? undefined : filters.greenhouse;
  const { data, loading } = useScouting({
    from: filters.from,
    to: filters.to,
    greenhouse: ghForCall,
    crop: filters.crop,
  });

  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);

  // Reset obs filter when switching modes (pest options ≠ disease options).
  useEffect(() => {
    setObsFilters({
      observation: ALL_FILTER,
      section: ALL_FILTER,
      stage: ALL_FILTER,
    });
  }, [mode]);

  const opts = useMemo(
    () => (mode === "pest" ? pestFilterOptions(data) : diseaseFilterOptions(data)),
    [data, mode],
  );

  /** Per-zone observation count under the active filter. */
  const intensityByZone = useMemo(() => {
    const out = new Map<string, number>();
    if (!data) return out;
    for (const e of data.entries) {
      const zone = e.zone;
      if (!zone) continue;
      const list =
        mode === "pest" ? e.pests_scouting_entry : e.diseases_scouting_entry;
      let matched = 0;
      for (const row of list as any[]) {
        const name = mode === "pest" ? row.pest : row.disease;
        if (obsFilters.observation && name !== obsFilters.observation) continue;
        if (
          obsFilters.section &&
          (row.plant_section || "") !== obsFilters.section
        )
          continue;
        if (obsFilters.stage && (row.stage || "") !== obsFilters.stage) continue;
        matched += 1;
      }
      if (matched > 0) out.set(zone, (out.get(zone) || 0) + matched);
    }
    return out;
  }, [data, mode, obsFilters]);

  const max = Math.max(1, ...Array.from(intensityByZone.values()));

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
      // Optional greenhouse narrowing — skip zones outside the picked GH.
      if (
        filters.greenhouse !== ALL &&
        !z.bedName.startsWith(filters.greenhouse)
      ) {
        continue;
      }
      const intensity = (intensityByZone.get(z.zoneName) || 0) / max;
      const fill = fillFor(intensity);
      const layerObj = L.geoJSON(z.geometry, {
        style: () => ({
          color: "#4b5563",
          weight: intensity > 0 ? 0.6 : 0.3,
          opacity: 0.8,
          fillColor: fill,
          fillOpacity: intensity > 0 ? 0.75 : 0.18,
        }),
      });
      const count = intensityByZone.get(z.zoneName) || 0;
      layerObj.bindTooltip(
        `<div style="font:11px Inter,Arial,sans-serif">
           <b>${z.zoneName}</b><br/>${count} ${mode}${count !== 1 ? "s" : ""}
         </div>`,
        { sticky: true },
      );
      layerObj.addTo(layer);
      plotted++;
      try {
        bounds.extend(layerObj.getBounds());
      } catch {
        /* skip empty bounds */
      }
    }

    if (plotted && bounds.isValid()) {
      m.fitBounds(bounds.pad(0.05), { animate: false });
    }
  }, [zones, intensityByZone, max, filters.greenhouse, mode]);

  return (
    <div className="flex flex-col min-h-svh">
      <MapHeader
        title="Heatmaps"
        subtitle="Zone-level intensity from scouting data"
        value={filters}
        onChange={setFilters}
        rightSlot={
          <div className="flex flex-col gap-1 min-w-32">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pest">Pests</SelectItem>
                <SelectItem value="disease">Diseases</SelectItem>
              </SelectContent>
            </Select>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 px-4 md:px-6 py-2 text-xs text-muted-foreground border-b">
        <DashFilterRow
          obsLabel={mode === "pest" ? "Pest" : "Disease"}
          obsOptions={mode === "pest" ? (opts as any).pests : (opts as any).diseases}
          sectionOptions={(opts as any).sections}
          stageOptions={(opts as any).stages}
          value={obsFilters}
          onChange={setObsFilters}
        />
        <span className="ml-auto flex items-center gap-1.5">
          {FILL_RAMP.map((c, i) => (
            <span
              key={c}
              className="h-2.5 w-5 first:rounded-l last:rounded-r"
              style={{ background: c }}
              title={`${Math.round((i / (FILL_RAMP.length - 1)) * max)}`}
            />
          ))}
          <span className="tabular-nums">max {max}</span>
        </span>
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
