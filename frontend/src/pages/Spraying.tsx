/**
 * Spraying map — single-day sprayer movement view.
 *
 * Each sprayer's actual GPS track (from the mobile app's Sprayer GPS Log) is
 * drawn as a polyline in that sprayer's colour, and every zone they passed
 * through is shaded. Unlike scouting, the sprayer only picks a greenhouse — the
 * server already maps each GPS fix to the nearest Zone (no bed filter), so the
 * `zone` field on each log drives the shading; no client-side zone maths needed.
 *
 * Data flow:
 *   - fetchSprayerGpsLogs → Sprayer GPS Log rows for one date / greenhouse
 *   - fetchBedsAndZones   → IDB-cached bed/zone GeoJSON (warmed on boot)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { MapBase } from "@/components/MapBase";
import { MapControlPanel } from "@/components/maps/MapControlPanel";
import { MapFloatingCard } from "@/components/maps/MapFloatingCard";
import { MapKpiPill } from "@/components/maps/MapKpiPill";
import { KpiValueSkeleton, LoadProgress, RowsSkeleton } from "@/components/Loading";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ALL,
  RangeHeader,
  type RangeFilterValue,
} from "./maps/RangeHeader";
import {
  fetchBedsAndZones,
  fetchScoutImages,
  fetchScoutLookup,
  fetchSprayerGpsLogs,
  type SprayerGpsLog,
} from "@/lib/scouting-api";
import { initialsOf } from "@/lib/scouts-api";
import { ScoutRouteCard, type ScoutTrail } from "@/components/scouting/ScoutRouteCard";
import { flyToFarm, useMapSettings } from "@/hooks/use-map-settings";
import { currentWeekRange } from "@/lib/utils";
import {
  flattenZones,
  geometryCentroid,
  houseOf,
  zonesPerHouse,
  zonePolygonFromGeometry,
  type ZoneFeature,
} from "./maps/zone-utils";
import { routeEnd, zoneNumber } from "./maps/neat-route";
import {
  applyTrailSelection,
  drawTrail,
  escapeHtml,
  housesCovered,
  latestTrails,
  useBedRouter,
  zoneHeatStyle,
  type DrawnTrail,
  type TrailLayer,
} from "./maps/route-kit";

const SPRAYER_PALETTE = [
  "#0ea5e9",
  "#f97316",
  "#22c55e",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#eab308",
  "#ec4899",
  "#6366f1",
  "#84cc16",
];

function sprayerLabel(s: string): string {
  if (!s) return "Unknown";
  if (!s.includes("@")) return s;
  const prefix = s.split("@")[0];
  return prefix
    .split(/[._-]/g)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Metres between two lat/lng points (haversine) — for the distance KPI. */
function distMeters(a: [number, number], b: [number, number]): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

interface Pt {
  sprayer: string;
  zone: string | null;
  greenhouse: string;
  ts: string;
  lat: number;
  lng: number;
}

interface ZoneRoll {
  zone: string;
  sprayerPoints: Map<string, number>;
  days: Set<string>;
  totalPoints: number;
  lastTs: string;
  /** Distinct passes through the zone (consecutive pings in it count once). */
  passes: number;
}

/** One sprayer's walk through one greenhouse on one day, drawn as a neat route. */
type Trail = DrawnTrail;

export function Spraying({ initialCrop }: { initialCrop?: string } = {}) {
  const [filters, setFilters] = useState<RangeFilterValue>(() => ({
    crop: initialCrop || "Rose",
    farm: ALL,
    greenhouse: ALL,
    ...currentWeekRange(),
  }));
  const isSingleDay = filters.from === filters.to;
  const rangeDayCount = useMemo(() => {
    const a = new Date(`${filters.from}T00:00:00`).getTime();
    const b = new Date(`${filters.to}T00:00:00`).getTime();
    return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
  }, [filters.from, filters.to]);
  const [zones, setZones] = useState<ZoneFeature[]>([]);
  const [logs, setLogs] = useState<SprayerGpsLog[]>([]);
  const [loading, setLoading] = useState(false);
  // An empty day is a valid answer, so "has data" is "a response has landed".
  const [loaded, setLoaded] = useState(false);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [selectedTrail, setSelectedTrail] = useState<string | null>(null);
  const [hiddenSprayers, setHiddenSprayers] = useState<Set<string>>(new Set());

  const mapSettings = useMapSettings();

  // Bed/zone geometry — IDB-cached on app boot.
  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);

  // Employee id -> name and photo, as on the Scouting map (initials otherwise).
  const [names, setNames] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, string>>({});
  useEffect(() => {
    fetchScoutLookup().then(setNames);
    fetchScoutImages().then(setImages);
  }, []);
  const nameOf = useCallback((key: string) => names[key] || sprayerLabel(key), [names]);

  // Sprayer GPS logs for the chosen day / greenhouse.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const gh = filters.greenhouse === ALL ? undefined : filters.greenhouse;
    fetchSprayerGpsLogs(filters.from, filters.to, gh)
      .then((rows) => {
        if (alive) {
          setLogs(rows);
          setLoaded(true);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [filters.from, filters.to, filters.greenhouse]);

  const farmNeedle = filters.farm === ALL ? "" : filters.farm.toLowerCase();

  // Parse + narrow to valid points for the day (greenhouse filtered server-side;
  // farm filtered here against the greenhouse name).
  const points = useMemo<Pt[]>(() => {
    const out: Pt[] = [];
    for (const r of logs) {
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (farmNeedle && !(r.greenhouse || "").toLowerCase().includes(farmNeedle))
        continue;
      out.push({
        sprayer: r.employee || "Unknown",
        zone: r.zone || null,
        greenhouse: r.greenhouse || "",
        ts: r.captured_at || "",
        lat,
        lng,
      });
    }
    return out;
  }, [logs, farmNeedle]);

  // Per-zone roll-up (only zones actually covered today).
  const aggByZone = useMemo(() => {
    const out = new Map<string, ZoneRoll>();
    const lastZone = new Map<string, string>();
    for (const p of points) {
      if (!p.zone) continue;
      if (hiddenSprayers.has(p.sprayer)) continue;
      let row = out.get(p.zone);
      if (!row) {
        row = {
          zone: p.zone,
          sprayerPoints: new Map(),
          days: new Set(),
          totalPoints: 0,
          lastTs: "",
          passes: 0,
        };
        out.set(p.zone, row);
      }
      if (lastZone.get(p.sprayer) !== p.zone) row.passes += 1;
      lastZone.set(p.sprayer, p.zone);
      row.totalPoints += 1;
      if (p.ts) row.days.add(p.ts.slice(0, 10));
      if (p.ts > row.lastTs) row.lastTs = p.ts;
      row.sprayerPoints.set(p.sprayer, (row.sprayerPoints.get(p.sprayer) || 0) + 1);
    }
    return out;
  }, [points, hiddenSprayers]);

  const zoneByName = useMemo(() => {
    const m = new Map<string, ZoneFeature>();
    for (const z of zones) m.set(z.zoneName, z);
    return m;
  }, [zones]);

  // Sprayer palette — most points first → top-of-palette colour.
  const sprayerInfo = useMemo(() => {
    const totals: Record<string, { points: number; zones: Set<string> }> = {};
    for (const p of points) {
      if (!totals[p.sprayer]) totals[p.sprayer] = { points: 0, zones: new Set() };
      totals[p.sprayer].points += 1;
      if (p.zone) totals[p.sprayer].zones.add(p.zone);
    }
    const list = Object.entries(totals)
      .map(([key, v]) => ({
        key,
        label: nameOf(key),
        points: v.points,
        zones: v.zones.size,
      }))
      .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));
    const colorMap = new Map<string, string>();
    list.forEach((s, i) =>
      colorMap.set(s.key, SPRAYER_PALETTE[i % SPRAYER_PALETTE.length]),
    );
    return { list, colorMap };
  }, [points, nameOf]);

  // Per-sprayer track: the actual GPS path, time-ordered.
  const tracksBySprayer = useMemo(() => {
    const out = new Map<string, [number, number][]>();
    const ordered = [...points].sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
    );
    for (const p of ordered) {
      if (hiddenSprayers.has(p.sprayer)) continue;
      let path = out.get(p.sprayer);
      if (!path) {
        path = [];
        out.set(p.sprayer, path);
      }
      path.push([p.lat, p.lng]);
    }
    return out;
  }, [points, hiddenSprayers]);

  const stats = useMemo(() => {
    const sprayers = new Set<string>();
    let pts = 0;
    let distance = 0;
    tracksBySprayer.forEach((path, sprayer) => {
      sprayers.add(sprayer);
      pts += path.length;
      for (let i = 1; i < path.length; i++) distance += distMeters(path[i - 1], path[i]);
    });
    return { sprayers: sprayers.size, zones: aggByZone.size, points: pts, distance };
  }, [tracksBySprayer, aggByZone]);

  // Neat routes: each sprayer's zone-by-zone pings, time-ordered, cut into one
  // trail per day and greenhouse (a line never hops across either), then closed
  // up on screen by neatRoute. Pings outside every zone have no bed to route on.
  const router = useBedRouter(zones);
  const zonesPerGreenhouse = useMemo(() => zonesPerHouse(zones), [zones]);
  const trails = useMemo(() => {
    const out: Trail[] = [];
    const bySprayer = new Map<string, Pt[]>();
    for (const p of points) {
      if (!p.zone || hiddenSprayers.has(p.sprayer)) continue;
      const arr = bySprayer.get(p.sprayer) || [];
      arr.push(p);
      bySprayer.set(p.sprayer, arr);
    }
    bySprayer.forEach((pts, sprayer) => {
      pts.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      interface Visit { zone: string; bed: string; zoneNo: number; gh: string; ts: string; c: [number, number] }
      let cur: Visit[] = [];
      let prevKey = "";
      const flush = () => {
        if (!cur.length) return;
        const segments = router.neat(cur.map((v) => ({ bed: v.bed, zoneNo: v.zoneNo })));
        const beds: string[] = [];
        for (const v of cur) if (v.bed && !beds.includes(v.bed)) beds.push(v.bed);
        const date = cur[0].ts.slice(0, 10);
        out.push({
          key: `${sprayer}|${date}|${cur[0].gh}`,
          person: sprayer,
          greenhouse: cur[0].gh,
          date,
          segments,
          start: cur[0].c,
          end: routeEnd(segments, cur[cur.length - 1].c)!,
          zones: new Set(cur.map((v) => v.zone)),
          beds,
          firstTime: cur[0].ts.slice(11, 19),
          lastTime: cur[cur.length - 1].ts.slice(11, 19),
        });
        cur = [];
      };
      for (const p of pts) {
        const zf = zoneByName.get(p.zone!);
        const c = zf?.geometry && geometryCentroid(zf.geometry);
        if (!zf || !c) continue;
        const gh = p.greenhouse || houseOf(zf.bedName);
        const key = `${p.ts.slice(0, 10)}|${gh}`;
        if (key !== prevKey) flush();
        prevKey = key;
        // Consecutive pings in one zone are one stop, not a repeated vertex.
        if (cur.length && cur[cur.length - 1].zone === p.zone) continue;
        cur.push({ zone: p.zone!, bed: zf.bedName, zoneNo: zoneNumber(p.zone!), gh, ts: p.ts, c });
      }
      flush();
    });
    return out;
  }, [points, hiddenSprayers, zoneByName, router]);

  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  function dominantSprayer(row: ZoneRoll): string | null {
    let bestKey: string | null = null;
    let bestN = -1;
    row.sprayerPoints.forEach((n, k) => {
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

    const bounds = L.latLngBounds([]);

    // 1. Sprayed zones: the scouting look, in the dominant sprayer's colour.
    aggByZone.forEach((row, zoneName) => {
      const z = zoneByName.get(zoneName);
      if (!z?.geometry) return;
      const poly = zonePolygonFromGeometry(z.geometry);
      if (!poly) return;
      const key = dominantSprayer(row);
      const color = (key && sprayerInfo.colorMap.get(key)) || "#0ea5e9";
      const layerObj = L.geoJSON(poly as any, {
        style: () => zoneHeatStyle(color, row.passes),
      });
      layerObj.on("click", () => {
        setSelectedTrail(null);
        setSelectedZone(zoneName);
      });
      layerObj.bindTooltip(
        `<div style="font:11px var(--sd-font),Arial,sans-serif"><b>${escapeHtml(zoneName)}</b><br/>${row.totalPoints} ping${row.totalPoints === 1 ? "" : "s"}${key ? ` · ${escapeHtml(nameOf(key))}` : ""}</div>`,
        { direction: "top" },
      );
      layerObj.addTo(layer);
      try {
        bounds.extend(layerObj.getBounds());
      } catch {
        /* skip */
      }
    });

    // 2. Neat sprayer routes, drawn exactly as the scout routes: initials badge
    //    at the end, start dot, a click opens the route card.
    trailLayers.current.clear();
    const showBadge = latestTrails(trails, filters.greenhouse !== ALL);
    trails.forEach((t) => {
      const name = nameOf(t.person);
      trailLayers.current.set(
        t.key,
        drawTrail(layer, t, {
          color: sprayerInfo.colorMap.get(t.person) || "#0ea5e9",
          initials: initialsOf(name),
          showBadge: showBadge(t),
          tipHtml: `<div style="font:11px var(--sd-font),Arial,sans-serif"><b>${escapeHtml(name)}</b><br/>${escapeHtml(t.greenhouse || "—")} · ${t.zones.size} zones · ${t.date}</div>`,
          onOpen: () => {
            setSelectedZone(null);
            setSelectedTrail(t.key);
          },
        }),
      );
      for (const seg of t.segments) for (const pt of seg.points) bounds.extend(pt);
    });
    applyTrailSelection(trailLayers.current, layer, selectedRef.current);

    if (bounds.isValid()) {
      m.fitBounds(bounds.pad(0.05), { animate: false });
    } else if (mapSettings.lat || mapSettings.lon) {
      flyToFarm(m, mapSettings, filters.farm === ALL ? null : filters.farm, {
        animate: false,
      });
    }
  }, [aggByZone, zoneByName, trails, sprayerInfo, mapSettings, filters.farm, filters.greenhouse, nameOf]);

  // Highlight the open route and dim the rest.
  const trailLayers = useRef(new Map<string, TrailLayer>());
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selectedTrail;
    applyTrailSelection(trailLayers.current, layerRef.current, selectedTrail);
  }, [selectedTrail]);

  // Fly to the farm whenever the Farm dropdown changes.
  const farmFlyMounted = useRef(false);
  useEffect(() => {
    if (!farmFlyMounted.current) {
      farmFlyMounted.current = true;
      const t = setTimeout(() => {
        flyToFarm(mapRef.current, mapSettings, filters.farm === ALL ? null : filters.farm, {
          animate: false,
        });
      }, 60);
      return () => clearTimeout(t);
    }
    flyToFarm(mapRef.current, mapSettings, filters.farm === ALL ? null : filters.farm, {
      animate: true,
    });
  }, [filters.farm, mapSettings]);

  const detail = selectedZone ? aggByZone.get(selectedZone) : null;
  const detailSprayers = detail
    ? Array.from(detail.sprayerPoints.entries())
        .sort(([, a], [, b]) => b - a)
        .map(([k, n]) => ({
          key: k,
          label: nameOf(k),
          count: n,
          color: sprayerInfo.colorMap.get(k) || "#9ca3af",
        }))
    : [];

  // The open route's card, same as the scout's: who, house, date, coverage,
  // times, beds, and every house covered in the range.
  const openTrail = useMemo<ScoutTrail | null>(() => {
    const t = selectedTrail ? trails.find((x) => x.key === selectedTrail) : null;
    if (!t) return null;
    return {
      key: t.key,
      scoutId: t.person,
      name: nameOf(t.person),
      image: images[t.person],
      color: sprayerInfo.colorMap.get(t.person) || "#0ea5e9",
      greenhouse: t.greenhouse,
      date: t.date,
      zonesCovered: t.zones.size,
      zonesTotal: zonesPerGreenhouse.get(houseOf(t.beds[0] || t.greenhouse)) || 0,
      start: t.firstTime,
      end: t.lastTime,
      beds: t.beds,
      houses: housesCovered(trails, t.person, zonesPerGreenhouse),
    };
  }, [selectedTrail, trails, nameOf, images, sprayerInfo, zonesPerGreenhouse]);

  // First load: `loading` is still false on the very first paint, before the
  // effect fires. A filter change keeps the old tracks on screen.
  const skeleton = !loaded;

  const toggleSprayer = (key: string) =>
    setHiddenSprayers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <RangeHeader
        title="Spraying"
        subtitle="Up to one week · each sprayer's GPS track and the zones they covered"
        value={filters}
        onChange={setFilters}
      />

      <div className="relative flex-1 min-h-[55vh] lg:min-h-0" aria-busy={loading || undefined}>
        <div className="absolute inset-4 md:inset-6 isolate z-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <MapBase
            onReady={(m) => {
              mapRef.current = m;
            }}
          />

          {/* No fraction to report for this fetch — null sweeps, 0 would sit
              empty and read as stuck. Floats on the map's top edge so the
              basemap and the tracks already drawn stay in view. */}
          <LoadProgress
            active={loading}
            progress={null}
            className="absolute left-16 top-3 z-[1000] rounded-md bg-card/95 px-2 py-1.5 shadow-md backdrop-blur"
          />

          <MapKpiPill>
            {skeleton ? (
              <KpiValueSkeleton className="mx-auto h-4 w-40" />
            ) : (
              <>
                {stats.sprayers} sprayers · {stats.zones} zones · {stats.points} pings · {(stats.distance / 1000).toFixed(2)}km
                <span className="ml-2 text-muted-foreground">
                  {isSingleDay ? filters.from : `${filters.from} → ${filters.to}`}
                </span>
              </>
            )}
          </MapKpiPill>

          {/* The per-sprayer show/hide list floats under the zoom buttons. */}
          <MapControlPanel title="Sprayers in view" count={skeleton ? undefined : sprayerInfo.list.length}>
            <div className="flex items-center justify-end mb-1.5">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="text-[0.65rem] px-2 py-0.5 rounded border bg-card hover:bg-muted"
                  onClick={() => setHiddenSprayers(new Set())}
                >
                  All
                </button>
                <button
                  type="button"
                  className="text-[0.65rem] px-2 py-0.5 rounded border bg-card hover:bg-muted"
                  onClick={() =>
                    setHiddenSprayers(new Set(sprayerInfo.list.map((s) => s.key)))
                  }
                >
                  None
                </button>
              </div>
            </div>

            {skeleton ? (
              <RowsSkeleton rows={4} className="gap-0.5" />
            ) : sprayerInfo.list.length === 0 ? (
              <div className="text-[0.72rem] text-muted-foreground py-3 text-center">
                No spraying on this date.
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {sprayerInfo.list.map((s) => {
                  const off = hiddenSprayers.has(s.key);
                  const color = sprayerInfo.colorMap.get(s.key) || "#9ca3af";
                  return (
                    <label
                      key={s.key}
                      className={`flex items-center gap-2 px-1.5 py-1 rounded hover:bg-muted cursor-pointer transition-opacity ${off ? "opacity-50" : ""}`}
                    >
                      <Checkbox
                        checked={!off}
                        onCheckedChange={() => toggleSprayer(s.key)}
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
                        {s.zones}z · {s.points}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </MapControlPanel>

          {openTrail ? (
            <ScoutRouteCard
              key={openTrail.key}
              trail={openTrail}
              role="Sprayer"
              onClose={() => setSelectedTrail(null)}
            />
          ) : null}

          {detail ? (
            <MapFloatingCard
              key={detail.zone}
              eyebrow="Zone"
              title={detail.zone}
              onClose={() => setSelectedZone(null)}
              label={`Zone ${detail.zone}`}
              closeLabel="Close zone card"
              testId="zone-card"
            >
              <div className="-mt-2 mb-3 text-[0.7rem] text-muted-foreground">
                {detail.totalPoints} ping{detail.totalPoints === 1 ? "" : "s"}
                {!isSingleDay
                  ? ` · sprayed ${detail.days.size} of ${rangeDayCount} days`
                  : ""}
                {detail.lastTs ? ` · last ${detail.lastTs.slice(11)}` : ""}
              </div>
              <div className="flex flex-col gap-3">
                <div>
                  <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                    Sprayers here
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {detailSprayers.map((s) => (
                      <span
                        key={s.key}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border bg-card text-[0.7rem]"
                        title={`${s.count} pings`}
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
              </div>
            </MapFloatingCard>
          ) : null}
        </div>
      </div>

    </div>
  );
}
