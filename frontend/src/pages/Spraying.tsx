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
  fetchEmployeeNames,
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

const toRad = (v: number) => (v * Math.PI) / 180;

/** A fix that moved ≥ this many metres from the previous one is "moving";
 *  below it the sprayer was effectively stationary (dwelling). */
const MOVE_M = 1;
/** A fix sitting within this many metres of its assigned zone is snapped onto
 *  the zone so GPS jitter doesn't scatter the track just outside the shape. */
const CLAMP_M = 1;

/**
 * Snap a GPS fix onto its assigned zone when it sits just outside but within
 * ``CLAMP_M`` of the zone polygon. Returns the snapped [lat, lng], or null to
 * leave the point untouched (no geometry, already inside, or > CLAMP_M away).
 * Distances are computed in a local metres projection — accurate at this scale.
 */
function clampToZone(pt: [number, number], geom: any): [number, number] | null {
  const poly = zonePolygonFromGeometry(geom);
  const ring: number[][] | undefined = poly?.coordinates?.[0]; // [[lng,lat],…]
  if (!ring || ring.length < 3) return null;
  const [lat, lng] = pt;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos(toRad(lat));

  // point-in-polygon (ray cast in lat/lng) — leave fixes already in their zone
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  if (inside) return null;

  // nearest point on the boundary, in metres
  const px = lng * mPerLng, py = lat * mPerLat;
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0] * mPerLng, ay = ring[j][1] * mPerLat;
    const bx = ring[i][0] * mPerLng, by = ring[i][1] * mPerLat;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < bestD) {
      bestD = d;
      best = [cy / mPerLat, cx / mPerLng];
    }
  }
  return best && bestD <= CLAMP_M ? best : null;
}

interface TrackPt {
  lat: number;
  lng: number;
  /** moved ≥ MOVE_M from the previous fix */
  moving: boolean;
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
  // Employee ID (payroll, e.g. "MFK-00526") -> real employee_name.
  const [empNames, setEmpNames] = useState<Record<string, string>>({});

  const mapSettings = useMapSettings();

  // Display label for a sprayer: the actual employee name when we have it,
  // else the formatted email / raw ID fallback.
  const labelFor = useCallback(
    (key: string) => empNames[key] || sprayerLabel(key),
    [empNames],
  );

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

  // Resolve the payroll IDs in the logs to real employee names.
  useEffect(() => {
    const ids = Array.from(new Set(logs.map((r) => r.employee).filter(Boolean)));
    if (!ids.length) return;
    let alive = true;
    fetchEmployeeNames(ids).then((m) => {
      if (alive) setEmpNames(m);
    });
    return () => {
      alive = false;
    };
  }, [logs]);

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
        label: empNames[key] || sprayerLabel(key),
        points: v.points,
        zones: v.zones.size,
      }))
      .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label));
    const colorMap = new Map<string, string>();
    list.forEach((s, i) =>
      colorMap.set(s.key, SPRAYER_PALETTE[i % SPRAYER_PALETTE.length]),
    );
    return { list, colorMap };
  }, [points, empNames]);

  // Per-sprayer track: the actual GPS path, time-ordered, with each fix snapped
  // onto its zone (when within CLAMP_M) and flagged moving vs stationary.
  const tracksBySprayer = useMemo(() => {
    const out = new Map<string, TrackPt[]>();
    const ordered = [...points].sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0,
    );
    const bySpr = new Map<string, Pt[]>();
    for (const p of ordered) {
      if (hiddenSprayers.has(p.sprayer)) continue;
      let arr = bySpr.get(p.sprayer);
      if (!arr) {
        arr = [];
        bySpr.set(p.sprayer, arr);
      }
      arr.push(p);
    }
    bySpr.forEach((pts, sprayer) => {
      const track: TrackPt[] = [];
      let prev: [number, number] | null = null;
      for (const p of pts) {
        let lat = p.lat;
        let lng = p.lng;
        if (p.zone) {
          const z = zoneByName.get(p.zone);
          const snapped = z?.geometry
            ? clampToZone([p.lat, p.lng], z.geometry)
            : null;
          if (snapped) {
            lat = snapped[0];
            lng = snapped[1];
          }
        }
        const moving = prev ? distMeters(prev, [lat, lng]) >= MOVE_M : false;
        track.push({ lat, lng, moving });
        prev = [lat, lng];
      }
      out.set(sprayer, track);
    });
    return out;
  }, [points, hiddenSprayers, zoneByName]);

  const stats = useMemo(() => {
    const sprayers = new Set<string>();
    let pts = 0;
    let distance = 0;
    tracksBySprayer.forEach((track, sprayer) => {
      sprayers.add(sprayer);
      pts += track.length;
      for (let i = 1; i < track.length; i++)
        distance += distMeters(
          [track[i - 1].lat, track[i - 1].lng],
          [track[i].lat, track[i].lng],
        );
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

    // 2. Per-sprayer GPS track. A subtle continuous base line shows the whole
    //    path; the stretches where they were MOVING are over-drawn in a
    //    stronger shade, and STATIONARY dwell points are highlighted as dots —
    //    so the track reads at a glance without overwhelming the map.
    tracksBySprayer.forEach((track, sprayer) => {
      const color = sprayerInfo.colorMap.get(sprayer) || "#0ea5e9";
      const name = labelFor(sprayer);
      track.forEach((p) => bounds.extend([p.lat, p.lng] as L.LatLngExpression));

      const latlngs = track.map((p) => [p.lat, p.lng]) as L.LatLngExpression[];
      if (latlngs.length >= 2) {
        // subtle continuous base — the full walked path
        L.polyline(latlngs, {
          color,
          weight: 1.5,
          opacity: 0.3,
          lineJoin: "round",
          lineCap: "round",
        })
          .bindTooltip(
            `<div style="font:11px Inter,Arial,sans-serif"><b>${name}</b><br/>${track.length} pings</div>`,
            { sticky: true },
          )
          .addTo(layer);

        // stronger overlay on contiguous moving runs
        let run: L.LatLngExpression[] = [];
        const flush = () => {
          if (run.length >= 2)
            L.polyline(run, {
              color,
              weight: 3,
              opacity: 0.85,
              lineJoin: "round",
              lineCap: "round",
            }).addTo(layer);
          run = [];
        };
        for (let i = 0; i < track.length; i++) {
          if (i > 0 && track[i].moving) {
            if (!run.length) run.push([track[i - 1].lat, track[i - 1].lng]);
            run.push([track[i].lat, track[i].lng]);
          } else {
            flush();
          }
        }
        flush();
      }

      // highlighted dwell markers — collapse consecutive stationary fixes into
      // one dot, sized a little by how long they stood there.
      let i = 0;
      while (i < track.length) {
        if (track[i].moving) {
          i++;
          continue;
        }
        let j = i;
        let sumLat = 0;
        let sumLng = 0;
        while (j < track.length && !track[j].moving) {
          sumLat += track[j].lat;
          sumLng += track[j].lng;
          j++;
        }
        const n = j - i;
        L.circleMarker([sumLat / n, sumLng / n] as L.LatLngExpression, {
          radius: Math.min(7, 3 + Math.log2(n + 1)),
          color: "#ffffff",
          weight: 1,
          fillColor: color,
          fillOpacity: 0.9,
        })
          .bindTooltip(
            `${name} · stationary (${n} ping${n === 1 ? "" : "s"})`,
            { sticky: true },
          )
          .addTo(layer);
        i = j;
      }

      // start / end caps
      const first = track[0];
      const last = track[track.length - 1];
      if (first) {
        L.circleMarker([first.lat, first.lng] as L.LatLngExpression, {
          radius: 6,
          color: "#ffffff",
          weight: 2,
          fillColor: color,
          fillOpacity: 1,
        })
          .bindTooltip(`Start · ${name}`, { sticky: true })
          .addTo(layer);
      }
      if (last && track.length > 1) {
        L.circleMarker([last.lat, last.lng] as L.LatLngExpression, {
          radius: 6,
          color,
          weight: 2,
          fillColor: "#ffffff",
          fillOpacity: 1,
        })
          .bindTooltip(`End · ${name}`, { sticky: true })
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
  }, [aggByZone, zoneByName, tracksBySprayer, sprayerInfo, mapSettings, filters.farm, labelFor]);

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
          label: labelFor(k),
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
    <div className="flex flex-col min-h-svh">
      <RangeHeader
        title="Spraying"
        subtitle="Up to one week · each sprayer's GPS track and the zones they covered"
        value={filters}
        onChange={setFilters}
        showCrop={false}
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

        <div className="border-l bg-card p-3 overflow-auto">
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

      <LoadingOverlay open={loading} progress={0} />
    </div>
  );
}
