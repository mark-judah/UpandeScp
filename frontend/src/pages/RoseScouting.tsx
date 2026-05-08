/**
 * Rose Scouting map — port of upande_scp/www/rose_scouting/index.html.
 *
 * Single-day movement view for one crop/farm/greenhouse: each scouted
 * zone is outlined in the colour of the scout who covered it, and the
 * scout's actual walking path is drawn as a polyline connecting the
 * centroids of every zone they visited, in chronological order
 * (mirrors the legacy ``renderScoutFlowLines`` logic).
 *
 * Data flow:
 *   - useScouting → IDB-cached entries for one date
 *   - fetchBedsAndZones → IDB-cached bed/zone GeoJSON (warmed on boot)
 *   - useObservationColors → canonical pest/disease swatches in the
 *     side detail card
 *
 * Leaflet container is wrapped in ``isolate z-0`` so the date picker
 * + filter popovers always paint above the map.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { LoadingStrip } from "@/components/LoadingStrip";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ALL,
  SingleDayHeader,
  type SingleDayFilterValue,
} from "./maps/SingleDayHeader";
import { fetchBedsAndZones } from "@/lib/scouting-api";
import { flyToFarm, useMapSettings } from "@/hooks/use-map-settings";
import {
  pestColor,
  diseaseColor,
  useObservationColors,
} from "@/lib/observation-colors";
import { ymd } from "@/lib/utils";
import {
  flattenZones,
  geometryCentroid,
  zonePolygonFromGeometry,
  type ZoneFeature,
} from "./maps/zone-utils";
import type { ScoutingEntry } from "@/lib/scouting-types";

/** Per-scout palette — verbatim port of the legacy `palette` array, so a
 *  scout who's used the old www page recognises their colour. */
const SCOUT_PALETTE = [
  "#ef4444",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#06b6d4",
  "#f43f5e",
  "#22c55e",
  "#a78bfa",
  "#fb923c",
];

function ghOf(zoneOrBed: string): string {
  const i = zoneOrBed.indexOf(" - Bed ");
  return i >= 0 ? zoneOrBed.slice(0, i) : zoneOrBed.split(" - ")[0];
}

function scoutLabel(s: string): string {
  if (!s) return "Unknown";
  if (!s.includes("@")) return s;
  const prefix = s.split("@")[0];
  return prefix
    .split(/[._-]/g)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

interface ScoutVisit {
  scout: string;
  zone: string;
  /** Sortable timestamp — falls back to time_of_capture string. */
  ts: string;
  centroid: [number, number];
}

interface ZoneRoll {
  zone: string;
  scoutEntries: Map<string, number>;
  pests: Record<string, number>;
  diseases: Record<string, number>;
  beds: Set<string>;
  totalEntries: number;
  lastTs: string;
}

export function RoseScouting() {
  const [filters, setFilters] = useState<SingleDayFilterValue>(() => ({
    crop: "Rose",
    farm: ALL,
    greenhouse: ALL,
    date: ymd(new Date()),
  }));
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [hiddenScouts, setHiddenScouts] = useState<Set<string>>(new Set());

  const ghForCall =
    filters.greenhouse === ALL ? undefined : filters.greenhouse;
  // Single-day query: from === to. Cache is day-precise.
  const { data, loading } = useScouting({
    from: filters.date,
    to: filters.date,
    greenhouse: ghForCall,
    crop: filters.crop || "Rose",
  });

  // Live doctype colour map (so the side card swatches reflect operator
  // edits to Pest / Plant Disease colours).
  useObservationColors();
  const mapSettings = useMapSettings();

  // Geometry — IDB-cached on app boot.
  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);

  const farmNeedle = filters.farm === ALL ? "" : filters.farm.toLowerCase();
  const inFarm = (e: ScoutingEntry): boolean => {
    if (!farmNeedle) return true;
    return (e.greenhouse || e.block || "")
      .toLowerCase()
      .includes(farmNeedle);
  };

  // Day's entries with zone, narrowed by farm + greenhouse selectors.
  const dayEntries = useMemo(() => {
    if (!data) return [];
    return data.entries.filter(
      (e) =>
        e.date_of_capture === filters.date &&
        e.zone &&
        inFarm(e) &&
        (filters.greenhouse === ALL ||
          e.zone.startsWith(filters.greenhouse)),
    );
  }, [data, filters.date, farmNeedle, filters.greenhouse]);

  // ── Per-zone aggregate (only zones actually scouted today). ──
  const aggByZone = useMemo(() => {
    const out = new Map<string, ZoneRoll>();
    for (const e of dayEntries) {
      let row = out.get(e.zone!);
      if (!row) {
        row = {
          zone: e.zone!,
          scoutEntries: new Map(),
          pests: {},
          diseases: {},
          beds: new Set(),
          totalEntries: 0,
          lastTs: "",
        };
        out.set(e.zone!, row);
      }
      row.totalEntries += 1;
      if (e.bed) row.beds.add(e.bed);
      const ts = `${e.date_of_capture} ${e.time_of_capture || ""}`.trim();
      if (ts > row.lastTs) row.lastTs = ts;
      const sk = e.scouts_name || "";
      if (sk) row.scoutEntries.set(sk, (row.scoutEntries.get(sk) || 0) + 1);
      e.pests_scouting_entry?.forEach((p) => {
        if (!p.pest) return;
        row!.pests[p.pest] = (row!.pests[p.pest] || 0) + (p.count || 1);
      });
      e.diseases_scouting_entry?.forEach((d) => {
        if (!d.disease) return;
        row!.diseases[d.disease] = (row!.diseases[d.disease] || 0) + 1;
      });
    }
    return out;
  }, [dayEntries]);

  // Zone lookup + centroid lookup (memoised; geometry is parsed once).
  const zoneByName = useMemo(() => {
    const m = new Map<string, ZoneFeature>();
    for (const z of zones) m.set(z.zoneName, z);
    return m;
  }, [zones]);

  const centroidByZone = useMemo(() => {
    const m = new Map<string, [number, number]>();
    aggByZone.forEach((_, zoneName) => {
      const z = zoneByName.get(zoneName);
      if (!z?.geometry) return;
      const c = geometryCentroid(z.geometry);
      if (c) m.set(zoneName, c);
    });
    return m;
  }, [aggByZone, zoneByName]);

  // ── Scout palette (most-active first → top-of-palette colour). ──
  const scoutInfo = useMemo(() => {
    const totals: Record<
      string,
      { entries: number; zones: Set<string> }
    > = {};
    aggByZone.forEach((row) => {
      row.scoutEntries.forEach((n, scout) => {
        if (!totals[scout]) totals[scout] = { entries: 0, zones: new Set() };
        totals[scout].entries += n;
        totals[scout].zones.add(row.zone);
      });
    });
    const list = Object.entries(totals)
      .map(([key, v]) => ({
        key,
        label: scoutLabel(key),
        entries: v.entries,
        zones: v.zones.size,
      }))
      .sort(
        (a, b) =>
          b.entries - a.entries || a.label.localeCompare(b.label),
      );
    const colorMap = new Map<string, string>();
    list.forEach((s, i) => {
      colorMap.set(s.key, SCOUT_PALETTE[i % SCOUT_PALETTE.length]);
    });
    return { list, colorMap };
  }, [aggByZone]);

  // ── Visits in time order — drives the per-scout flow polyline. ──
  const visitsByScout = useMemo(() => {
    const ordered = [...dayEntries].sort((a, b) => {
      const ta = `${a.date_of_capture} ${a.time_of_capture || ""}`;
      const tb = `${b.date_of_capture} ${b.time_of_capture || ""}`;
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const out = new Map<string, ScoutVisit[]>();
    for (const e of ordered) {
      if (!e.scouts_name || !e.zone) continue;
      if (hiddenScouts.has(e.scouts_name)) continue;
      const c = centroidByZone.get(e.zone);
      if (!c) continue;
      let path = out.get(e.scouts_name);
      if (!path) {
        path = [];
        out.set(e.scouts_name, path);
      }
      // De-dup consecutive entries in the same zone — the flow line
      // should connect zone-to-zone, not redraw the same vertex.
      const last = path[path.length - 1];
      if (last && last.zone === e.zone) continue;
      path.push({
        scout: e.scouts_name,
        zone: e.zone,
        ts: `${e.date_of_capture} ${e.time_of_capture || ""}`,
        centroid: c,
      });
    }
    return out;
  }, [dayEntries, centroidByZone, hiddenScouts]);

  // ── KPIs (Scouts · Beds · Zones · Entries). ──
  const stats = useMemo(() => {
    const scouts = new Set<string>();
    const beds = new Set<string>();
    let entries = 0;
    aggByZone.forEach((row) => {
      row.scoutEntries.forEach((n, s) => {
        if (hiddenScouts.has(s)) return;
        scouts.add(s);
        entries += n;
      });
      row.beds.forEach((b) => beds.add(b));
    });
    return {
      scouts: scouts.size,
      beds: beds.size,
      zones: aggByZone.size,
      entries,
    };
  }, [aggByZone, hiddenScouts]);

  // ── Map plumbing. ──
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  function dominantScout(row: ZoneRoll): string | null {
    let bestKey: string | null = null;
    let bestN = -1;
    row.scoutEntries.forEach((n, k) => {
      if (hiddenScouts.has(k)) return;
      if (n > bestN || (n === bestN && (bestKey == null || k < bestKey))) {
        bestN = n;
        bestKey = k;
      }
    });
    return bestKey;
  }

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    if (!layerRef.current) layerRef.current = L.layerGroup().addTo(m);
    const layer = layerRef.current;
    layer.clearLayers();
    if (!aggByZone.size) return;

    const bounds = L.latLngBounds([]);

    // 1. Scouted zone polygons — only the zones touched today, faint
    //    fill in the dominant scout's colour.
    aggByZone.forEach((row, zoneName) => {
      const z = zoneByName.get(zoneName);
      if (!z?.geometry) return;
      const poly = zonePolygonFromGeometry(z.geometry);
      if (!poly) return;
      const scoutKey = dominantScout(row);
      if (!scoutKey) return;
      const color = scoutInfo.colorMap.get(scoutKey) || "#5BB45D";

      const layerObj = L.geoJSON(poly as any, {
        style: () => ({
          color,
          weight: 1.2,
          opacity: 0.9,
          fillColor: color,
          fillOpacity: 0.25,
        }),
      });
      layerObj.on("click", () => setSelectedZone(zoneName));
      layerObj.bindTooltip(
        `<div style="font:11px Inter,Arial,sans-serif">
           <b>${zoneName}</b><br/>
           ${row.totalEntries} entr${row.totalEntries === 1 ? "y" : "ies"} ·
           ${scoutLabel(scoutKey)}
         </div>`,
        { sticky: true },
      );
      layerObj.addTo(layer);
      try {
        bounds.extend(layerObj.getBounds());
      } catch {
        /* skip */
      }
    });

    // 2. Per-scout flow polylines — centroids of visited zones in time
    //    order. This is the actual walking-path trace.
    visitsByScout.forEach((visits, scout) => {
      if (visits.length < 2) return;
      const color = scoutInfo.colorMap.get(scout) || "#5BB45D";
      const points = visits.map((v) => v.centroid as L.LatLngExpression);
      const polyline = L.polyline(points, {
        color,
        weight: 3,
        opacity: 0.85,
        lineJoin: "round",
        lineCap: "round",
      });
      polyline.bindTooltip(
        `<div style="font:11px Inter,Arial,sans-serif">
           <b>${scoutLabel(scout)}</b><br/>
           ${visits.length} zone${visits.length === 1 ? "" : "s"} visited
         </div>`,
        { sticky: true },
      );
      polyline.addTo(layer);

      // Numbered start / end markers so the direction of the walk is
      // obvious without animation.
      const first = visits[0].centroid;
      const last = visits[visits.length - 1].centroid;
      L.circleMarker(first, {
        radius: 6,
        color: "#ffffff",
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
      })
        .bindTooltip(
          `Start · ${visits[0].zone} · ${(visits[0].ts || "").slice(11) || "—"}`,
          { sticky: true },
        )
        .addTo(layer);
      if (visits.length > 1) {
        L.circleMarker(last, {
          radius: 6,
          color: color,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        })
          .bindTooltip(
            `End · ${visits[visits.length - 1].zone} · ${(visits[visits.length - 1].ts || "").slice(11) || "—"}`,
            { sticky: true },
          )
          .addTo(layer);
      }
    });

    if (bounds.isValid()) {
      m.fitBounds(bounds.pad(0.05), { animate: false });
    } else if (mapSettings.lat || mapSettings.lon) {
      // No scouting today — fall back to the picked-farm centre.
      flyToFarm(
        m,
        mapSettings,
        filters.farm === ALL ? null : filters.farm,
        { animate: false },
      );
    }
  }, [aggByZone, zoneByName, visitsByScout, scoutInfo, mapSettings, filters.farm]);

  // Fly to the farm whenever the operator changes the Farm dropdown.
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

  // ── Side detail card. ──
  const detail = selectedZone ? aggByZone.get(selectedZone) : null;
  const topPests = detail
    ? Object.entries(detail.pests)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
    : [];
  const topDiseases = detail
    ? Object.entries(detail.diseases)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
    : [];
  const detailScouts = detail
    ? Array.from(detail.scoutEntries.entries())
        .sort(([, a], [, b]) => b - a)
        .map(([k, n]) => ({
          key: k,
          label: scoutLabel(k),
          count: n,
          color: scoutInfo.colorMap.get(k) || "#9ca3af",
        }))
    : [];

  const toggleScout = (key: string) =>
    setHiddenScouts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col min-h-svh">
      <SingleDayHeader
        title="Rose Scouting"
        subtitle="Single-day · zones scouted form the scout's walking path"
        value={filters}
        onChange={setFilters}
      />

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_1fr]">
        <div className="relative">
          <div className="absolute inset-0 isolate z-0">
            <MapBase
              onReady={(m) => {
                mapRef.current = m;
              }}
            />
          </div>

          {/* Bottom-right summary panel — KPIs + scout legend, exactly
              the role the legacy ``scout-summary`` div played. */}
          <Card className="absolute bottom-4 right-4 z-10 w-72 max-h-[70vh] overflow-y-auto bg-card/95 backdrop-blur shadow-md p-3">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Coverage summary</CardTitle>
              <CardDescription className="text-[0.7rem] tabular-nums">
                {filters.date}
              </CardDescription>
            </CardHeader>

            <div className="grid grid-cols-4 gap-2 mb-3">
              {[
                ["Scouts", stats.scouts],
                ["Beds", stats.beds],
                ["Zones", stats.zones],
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
                Scouts in view
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="text-[0.65rem] px-2 py-0.5 rounded border bg-card hover:bg-muted"
                  onClick={() => setHiddenScouts(new Set())}
                >
                  All
                </button>
                <button
                  type="button"
                  className="text-[0.65rem] px-2 py-0.5 rounded border bg-card hover:bg-muted"
                  onClick={() =>
                    setHiddenScouts(
                      new Set(scoutInfo.list.map((s) => s.key)),
                    )
                  }
                >
                  None
                </button>
              </div>
            </div>

            {scoutInfo.list.length === 0 ? (
              <div className="text-[0.72rem] text-muted-foreground py-3 text-center">
                No scouting on this date.
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {scoutInfo.list.map((s) => {
                  const off = hiddenScouts.has(s.key);
                  const color = scoutInfo.colorMap.get(s.key) || "#9ca3af";
                  return (
                    <label
                      key={s.key}
                      className={`flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted cursor-pointer transition-opacity ${off ? "opacity-50" : ""}`}
                    >
                      <Checkbox
                        checked={!off}
                        onCheckedChange={() => toggleScout(s.key)}
                      />
                      <span
                        className="h-3 w-3 rounded-full border shrink-0"
                        style={{ background: color }}
                        aria-hidden
                      />
                      <span className="text-[0.72rem] flex-1 truncate">
                        {s.label}
                      </span>
                      <span className="text-[0.65rem] tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                        {s.zones}z · {s.entries}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {/* Right rail — clicked-zone detail. */}
        <div className="border-l bg-card p-3 overflow-auto">
          {detail ? (
            <Card className="p-3 shadow-none border-0">
              <CardHeader className="p-0 pb-2">
                <CardTitle className="text-sm">{detail.zone}</CardTitle>
                <CardDescription className="text-[0.7rem]">
                  {detail.totalEntries} entr
                  {detail.totalEntries === 1 ? "y" : "ies"}
                  {detail.lastTs ? ` · last ${detail.lastTs.slice(11)}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 flex flex-col gap-3">
                {detailScouts.length > 0 && (
                  <div>
                    <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                      Scouts here
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {detailScouts.map((s) => (
                        <span
                          key={s.key}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border bg-card text-[0.7rem]"
                          title={`${s.count} entries`}
                        >
                          <span
                            className="h-2 w-2 rounded-full border"
                            style={{ background: s.color }}
                            aria-hidden
                          />
                          {s.label}
                          <span className="tabular-nums text-muted-foreground">
                            {s.count}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                    Top Pests
                  </div>
                  {topPests.length ? (
                    topPests.map(([name, count]) => (
                      <div
                        key={name}
                        className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)] mb-1"
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full border shrink-0"
                          style={{ background: pestColor(name) }}
                          aria-hidden
                        />
                        <span className="truncate flex-1">{name}</span>
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
                        className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)] mb-1"
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full border shrink-0"
                          style={{ background: diseaseColor(name) }}
                          aria-hidden
                        />
                        <span className="truncate flex-1">{name}</span>
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
                <CardTitle className="text-sm">Pick a zone</CardTitle>
                <CardDescription className="text-[0.7rem]">
                  Click any coloured zone on the map to see who walked it
                  and what they observed.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 mt-3">
                <Badge variant="outline" className="text-[0.65rem]">
                  {aggByZone.size} scouted zone
                  {aggByZone.size === 1 ? "" : "s"}
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
