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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { LoadingOverlay } from "@/components/LoadingOverlay";
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
  RangeHeader,
  type RangeFilterValue,
} from "./maps/RangeHeader";
import { fetchBedsAndZones, fetchScoutLookup } from "@/lib/scouting-api";
import { flyToFarm, useMapSettings } from "@/hooks/use-map-settings";
import {
  pestColor,
  diseaseColor,
  useObservationColors,
} from "@/lib/observation-colors";
import { currentWeekRange } from "@/lib/utils";
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
  /** Greenhouse the zone belongs to — the trail is cut when this changes. */
  greenhouse: string;
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
  days: Set<string>;
  totalEntries: number;
  lastTs: string;
}

export function RoseScouting() {
  const [filters, setFilters] = useState<RangeFilterValue>(() => ({
    crop: "Rose",
    farm: ALL,
    greenhouse: ALL,
    ...currentWeekRange(),
  }));
  const isSingleDay = filters.from === filters.to;
  // Distinct days in the selected range (denominator for "covered N of M days").
  const rangeDayCount = useMemo(() => {
    const a = new Date(`${filters.from}T00:00:00`).getTime();
    const b = new Date(`${filters.to}T00:00:00`).getTime();
    return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
  }, [filters.from, filters.to]);
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [hiddenScouts, setHiddenScouts] = useState<Set<string>>(new Set());

  const ghForCall =
    filters.greenhouse === ALL ? undefined : filters.greenhouse;
  // Single-day query: from === to. Cache is day-precise.
  const { data, loading, progress, weeksLoaded, weeksTotal } = useScouting({
    from: filters.from,
    to: filters.to,
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

  // Employee-id → readable name, so the summary shows the scout's name rather
  // than their payroll number when scouts_name is a numeric employee id.
  const [scoutNames, setScoutNames] = useState<Record<string, string>>({});
  useEffect(() => {
    fetchScoutLookup().then(setScoutNames);
  }, []);
  const nameOf = useCallback(
    (key: string) => scoutNames[key] || scoutLabel(key),
    [scoutNames],
  );

  const farmNeedle = filters.farm === ALL ? "" : filters.farm.toLowerCase();
  const inFarm = (e: ScoutingEntry): boolean => {
    if (!farmNeedle) return true;
    return (e.greenhouse || e.block || "")
      .toLowerCase()
      .includes(farmNeedle);
  };

  // Entries in the selected range with zone, narrowed by farm + greenhouse.
  // Trap-check entries are excluded — a trap visit is a fixed-point check, not
  // part of the scout's walking path, and it has its own Traps map. Leaving
  // them in pulled the movement trail off to trap posts.
  const dayEntries = useMemo(() => {
    if (!data) return [];
    return data.entries.filter(
      (e) =>
        !!e.date_of_capture &&
        e.date_of_capture >= filters.from &&
        e.date_of_capture <= filters.to &&
        e.zone &&
        !(e.trap_scouting_entry && e.trap_scouting_entry.length > 0) &&
        inFarm(e) &&
        (filters.greenhouse === ALL ||
          e.zone.startsWith(filters.greenhouse)),
    );
  }, [data, filters.from, filters.to, farmNeedle, filters.greenhouse]);

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
          days: new Set(),
          totalEntries: 0,
          lastTs: "",
        };
        out.set(e.zone!, row);
      }
      row.totalEntries += 1;
      if (e.bed) row.beds.add(e.bed);
      if (e.date_of_capture) row.days.add(e.date_of_capture);
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
        label: nameOf(key),
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
  }, [aggByZone, nameOf]);

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
        greenhouse: e.greenhouse || e.block || "",
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
           ${nameOf(scoutKey)}
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

    // 2. Per-scout flow polylines, split into contiguous SEGMENTS. A line
    //    never connects across days OR across greenhouses — when the scout's
    //    next visit is in a different greenhouse the trail is CUT and a fresh
    //    segment starts there (previously the path hopped greenhouse-to-
    //    greenhouse, producing cross-field spaghetti). The trail itself is a
    //    single faint neutral colour; only the start/end dots carry the
    //    scout's colour so the person stays identifiable.
    visitsByScout.forEach((visits, scout) => {
      // Per-scout colour, drawn faint so it reads as a subtle tint — a red
      // scout shows as a muted greyish red, not a vivid line.
      const color = scoutInfo.colorMap.get(scout) || "#5BB45D";
      const segments: ScoutVisit[][] = [];
      let cur: ScoutVisit[] = [];
      let prevKey = "";
      for (const v of visits) {
        const key = `${(v.ts || "").slice(0, 10)}|${v.greenhouse}`;
        if (key !== prevKey && cur.length) {
          segments.push(cur);
          cur = [];
        }
        prevKey = key;
        cur.push(v);
      }
      if (cur.length) segments.push(cur);

      segments.forEach((seg) => {
        if (seg.length >= 2) {
          const points = seg.map((v) => v.centroid as L.LatLngExpression);
          L.polyline(points, {
            color,
            weight: 2,
            opacity: 0.4,
            lineJoin: "round",
            lineCap: "round",
          })
            .bindTooltip(
              `<div style="font:11px var(--sd-font),Arial,sans-serif">
                 <b>${nameOf(scout)}</b><br/>
                 ${seg[0].greenhouse || "—"} · ${seg.length} zones · ${(seg[0].ts || "").slice(0, 10)}
               </div>`,
              { sticky: true },
            )
            .addTo(layer);
        }
        // Start / end markers so the direction of each greenhouse walk is clear.
        L.circleMarker(seg[0].centroid, {
          radius: 5,
          color: "#ffffff",
          weight: 2,
          fillColor: color,
          fillOpacity: 1,
        })
          .bindTooltip(
            `Start · ${seg[0].zone} · ${(seg[0].ts || "").slice(11) || "—"}`,
            { sticky: true },
          )
          .addTo(layer);
        if (seg.length > 1) {
          const lastV = seg[seg.length - 1];
          L.circleMarker(lastV.centroid, {
            radius: 5,
            color,
            weight: 2,
            fillColor: "#ffffff",
            fillOpacity: 1,
          })
            .bindTooltip(
              `End · ${lastV.zone} · ${(lastV.ts || "").slice(11) || "—"}`,
              { sticky: true },
            )
            .addTo(layer);
        }
      });
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
  }, [aggByZone, zoneByName, visitsByScout, scoutInfo, mapSettings, filters.farm, nameOf]);

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
          label: nameOf(k),
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
    <div className="flex flex-col h-svh overflow-hidden">
      <RangeHeader
        title="Scouting"
        subtitle="Up to one week · zones scouted, with repeat-day overlap"
        value={filters}
        onChange={setFilters}
        showCrop={false}
      />

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_1fr]">
        <div className="relative min-h-[55vh] lg:min-h-0">
          <div className="absolute inset-4 md:inset-6 isolate z-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
            <MapBase
              onReady={(m) => {
                mapRef.current = m;
              }}
            />
          </div>
        </div>

        {/* Right rail — clicked-zone detail, then the coverage summary below
            it. Scrolls on its own; capped height on small screens so the map
            above stays usable. */}
        <div className="m-4 md:m-6 lg:ml-0 rounded-[20px] border bg-card p-4 shadow-[var(--sd-shadow-1)] overflow-auto flex flex-col gap-3 max-h-[45vh] lg:max-h-none">
          {detail ? (
            <Card className="p-3 shadow-none border">
              <CardHeader className="p-0 pb-2">
                <CardTitle className="text-sm">{detail.zone}</CardTitle>
                <CardDescription className="text-[0.7rem]">
                  {detail.totalEntries} entr
                  {detail.totalEntries === 1 ? "y" : "ies"}
                  {!isSingleDay
                    ? ` · covered ${detail.days.size} of ${rangeDayCount} days`
                    : ""}
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

          {/* Coverage summary — KPIs + scout legend. Now lives under the
              zone detail in the rail (was a floating map overlay). */}
          <Card className="p-3 shadow-none border">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Coverage summary</CardTitle>
              <CardDescription className="text-[0.7rem] tabular-nums">
                {isSingleDay ? filters.from : `${filters.from} → ${filters.to}`}
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
                    setHiddenScouts(new Set(scoutInfo.list.map((s) => s.key)))
                  }
                >
                  None
                </button>
              </div>
            </div>

            {scoutInfo.list.length === 0 ? (
              <div className="text-[0.72rem] text-muted-foreground py-3 text-center">
                No scouting in this range.
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
