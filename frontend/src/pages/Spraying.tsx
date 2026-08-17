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

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
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
import {
  fetchBedsAndZones,
  fetchSprayerGpsLogs,
  type SprayerGpsLog,
} from "@/lib/scouting-api";
import { flyToFarm, useMapSettings } from "@/hooks/use-map-settings";
import { currentWeekRange } from "@/lib/utils";
import {
  flattenZones,
  geometryCentroid,
  zonePolygonFromGeometry,
  type ZoneFeature,
} from "./maps/zone-utils";

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
}

export function Spraying() {
  const [filters, setFilters] = useState<RangeFilterValue>(() => ({
    crop: "Rose",
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
  const [selectedZone, setSelectedZone] = useState<string | null>(null);
  const [hiddenSprayers, setHiddenSprayers] = useState<Set<string>>(new Set());

  const mapSettings = useMapSettings();

  // Bed/zone geometry — IDB-cached on app boot.
  useEffect(() => {
    fetchBedsAndZones().then((vs) => setZones(flattenZones(vs)));
  }, []);

  // Sprayer GPS logs for the chosen day / greenhouse.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const gh = filters.greenhouse === ALL ? undefined : filters.greenhouse;
    fetchSprayerGpsLogs(filters.from, filters.to, gh)
      .then((rows) => {
        if (alive) setLogs(rows);
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
        };
        out.set(p.zone, row);
      }
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
        label: sprayerLabel(key),
        points: v.points,
        zones: v.zones.size,
      }))
      .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));
    const colorMap = new Map<string, string>();
    list.forEach((s, i) =>
      colorMap.set(s.key, SPRAYER_PALETTE[i % SPRAYER_PALETTE.length]),
    );
    return { list, colorMap };
  }, [points]);

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

    // 1. Covered zones — shaded in the dominant sprayer's colour.
    aggByZone.forEach((row, zoneName) => {
      const z = zoneByName.get(zoneName);
      if (!z?.geometry) return;
      const poly = zonePolygonFromGeometry(z.geometry);
      if (!poly) return;
      const key = dominantSprayer(row);
      const color = (key && sprayerInfo.colorMap.get(key)) || "#0ea5e9";
      const layerObj = L.geoJSON(poly as any, {
        style: () => ({
          color,
          weight: 1.2,
          opacity: 0.85,
          fillColor: color,
          fillOpacity: 0.22,
        }),
      });
      layerObj.on("click", () => setSelectedZone(zoneName));
      layerObj.bindTooltip(
        `<div style="font:11px Inter,Arial,sans-serif"><b>${zoneName}</b><br/>${row.totalPoints} ping${row.totalPoints === 1 ? "" : "s"}</div>`,
        { sticky: true },
      );
      layerObj.addTo(layer);
      const c = geometryCentroid(z.geometry);
      if (c) bounds.extend(c as L.LatLngExpression);
    });

    // 2. Per-sprayer GPS track — the real walking path.
    tracksBySprayer.forEach((path, sprayer) => {
      const color = sprayerInfo.colorMap.get(sprayer) || "#0ea5e9";
      path.forEach((pt) => bounds.extend(pt as L.LatLngExpression));
      if (path.length >= 2) {
        L.polyline(path as L.LatLngExpression[], {
          color, // per-sprayer colour, drawn faint (subtle tint)
          weight: 2,
          opacity: 0.4,
          lineJoin: "round",
          lineCap: "round",
        })
          .bindTooltip(
            `<div style="font:11px Inter,Arial,sans-serif"><b>${sprayerLabel(sprayer)}</b><br/>${path.length} pings</div>`,
            { sticky: true },
          )
          .addTo(layer);
      }
      const first = path[0];
      const last = path[path.length - 1];
      if (first) {
        L.circleMarker(first as L.LatLngExpression, {
          radius: 6,
          color: "#ffffff",
          weight: 2,
          fillColor: color,
          fillOpacity: 1,
        })
          .bindTooltip(`Start · ${sprayerLabel(sprayer)}`, { sticky: true })
          .addTo(layer);
      }
      if (last && path.length > 1) {
        L.circleMarker(last as L.LatLngExpression, {
          radius: 6,
          color,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        })
          .bindTooltip(`End · ${sprayerLabel(sprayer)}`, { sticky: true })
          .addTo(layer);
      }
    });

    if (bounds.isValid()) {
      m.fitBounds(bounds.pad(0.05), { animate: false });
    } else if (mapSettings.lat || mapSettings.lon) {
      flyToFarm(m, mapSettings, filters.farm === ALL ? null : filters.farm, {
        animate: false,
      });
    }
  }, [aggByZone, zoneByName, tracksBySprayer, sprayerInfo, mapSettings, filters.farm]);

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
          label: sprayerLabel(k),
          count: n,
          color: sprayerInfo.colorMap.get(k) || "#9ca3af",
        }))
    : [];

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
        showCrop={false}
      />

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[3fr_1fr]">
        <div className="relative">
          <div className="absolute inset-4 md:inset-6 isolate z-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
            <MapBase
              onReady={(m) => {
                mapRef.current = m;
              }}
            />
          </div>

          <Card className="absolute bottom-4 right-4 z-10 w-72 max-h-[70vh] overflow-y-auto bg-card/95 backdrop-blur shadow-md p-3">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Spraying summary</CardTitle>
              <CardDescription className="text-[0.7rem] tabular-nums">
                {isSingleDay ? filters.from : `${filters.from} → ${filters.to}`}
              </CardDescription>
            </CardHeader>

            <div className="grid grid-cols-4 gap-2 mb-3">
              {[
                ["Sprayers", String(stats.sprayers)],
                ["Zones", String(stats.zones)],
                ["Pings", String(stats.points)],
                ["Dist", `${(stats.distance / 1000).toFixed(2)}km`],
              ].map(([label, v]) => (
                <div
                  key={label}
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
                Sprayers in view
              </span>
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

            {sprayerInfo.list.length === 0 ? (
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
          </Card>
        </div>

        <div className="m-4 md:m-6 lg:ml-0 rounded-[20px] border bg-card p-4 shadow-[var(--sd-shadow-1)] overflow-auto">
          {detail ? (
            <Card className="p-3 shadow-none border-0">
              <CardHeader className="p-0 pb-2">
                <CardTitle className="text-sm">{detail.zone}</CardTitle>
                <CardDescription className="text-[0.7rem]">
                  {detail.totalPoints} ping{detail.totalPoints === 1 ? "" : "s"}
                  {!isSingleDay
                    ? ` · sprayed ${detail.days.size} of ${rangeDayCount} days`
                    : ""}
                  {detail.lastTs ? ` · last ${detail.lastTs.slice(11)}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 flex flex-col gap-3">
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
              </CardContent>
            </Card>
          ) : (
            <Card className="p-4">
              <CardHeader className="p-0">
                <CardTitle className="text-sm">Pick a zone</CardTitle>
                <CardDescription className="text-[0.7rem]">
                  Click any shaded zone to see which sprayers covered it.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 mt-3">
                <Badge variant="outline" className="text-[0.65rem]">
                  {aggByZone.size} zone{aggByZone.size === 1 ? "" : "s"} covered
                </Badge>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* No fraction to report for this fetch — null sweeps, 0 would sit
          empty and read as stuck. */}
      <LoadingOverlay open={loading} progress={null} />
    </div>
  );
}
