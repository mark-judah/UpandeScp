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
import { X } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import { MapBase } from "@/components/MapBase";
import { Bar, LoadProgress, TextSkeleton, firstLoad } from "@/components/Loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ALL,
  RangeHeader,
  type RangeFilterValue,
} from "./maps/RangeHeader";
import { fetchBedsAndZones, fetchScoutImages, fetchScoutLookup } from "@/lib/scouting-api";
import { initialsOf } from "@/lib/scouts-api";
import { ScoutRouteCard, type ScoutTrail } from "@/components/scouting/ScoutRouteCard";
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
  houseOf,
  zonesPerHouse,
  zonePolygonFromGeometry,
  type ZoneFeature,
} from "./maps/zone-utils";
import {
  neatRoute,
  routeEnd,
  zoneNumber,
  type BedGeometry,
  type Pt,
  type RouteSegment,
} from "./maps/neat-route";
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

/** Route line opacity at rest (dimmed/raised while a route card is open). */
const ROUTE_OPACITY = 0.5;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** The scout's initials in a small circle of their colour, at the route's end. */
function badgeIcon(initials: string, color: string, selected: boolean): L.DivIcon {
  const size = selected ? 30 : 24;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${color};color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font:600 ${selected ? 11 : 9}px var(--sd-font),Poppins,Arial,sans-serif;letter-spacing:.02em">${escapeHtml(initials)}</div>`,
  });
}

const ghOf = houseOf;

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
  bed: string;
  zoneNo: number;
  /** Greenhouse the zone belongs to — the trail is cut when this changes. */
  greenhouse: string;
  /** Sortable timestamp — falls back to time_of_capture string. */
  ts: string;
  centroid: [number, number];
}

/** One scout's walk through one greenhouse on one day — drawn as a neat route. */
interface Trail {
  key: string;
  scout: string;
  greenhouse: string;
  date: string;
  segments: RouteSegment[];
  start: Pt;
  end: Pt;
  zones: Set<string>;
  beds: string[];
  firstTime: string;
  lastTime: string;
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
  const [selectedTrail, setSelectedTrail] = useState<string | null>(null);

  const ghForCall =
    filters.greenhouse === ALL ? undefined : filters.greenhouse;
  // Single-day query: from === to. Cache is day-precise.
  const { data, loading, progress, error } = useScouting({
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
  const [scoutImages, setScoutImages] = useState<Record<string, string>>({});
  useEffect(() => {
    fetchScoutImages().then(setScoutImages);
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
      const zf = zoneByName.get(e.zone);
      path.push({
        scout: e.scouts_name,
        zone: e.zone,
        bed: zf?.bedName || e.bed || "",
        zoneNo: zoneNumber(e.zone),
        greenhouse: e.greenhouse || e.block || "",
        ts: `${e.date_of_capture} ${e.time_of_capture || ""}`,
        centroid: c,
      });
    }
    return out;
  }, [dayEntries, centroidByZone, zoneByName]);

  // ── KPIs (Scouts · Beds · Zones · Entries). ──
  const stats = useMemo(() => {
    const scouts = new Set<string>();
    const beds = new Set<string>();
    let entries = 0;
    aggByZone.forEach((row) => {
      row.scoutEntries.forEach((n, s) => {
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
  }, [aggByZone]);

  // ── Neat routes. Each scout's visits are cut into trails (one per day and
  //    greenhouse — a line never hops across either), and every trail is run
  //    through neatRoute so the bed starts/ends are closed up on screen. ──
  const bedZones = useMemo(() => {
    const m = new Map<string, Map<number, ZoneFeature>>();
    for (const z of zones) {
      const n = zoneNumber(z.zoneName);
      if (!Number.isFinite(n)) continue;
      let b = m.get(z.bedName);
      if (!b) m.set(z.bedName, (b = new Map()));
      b.set(n, z);
    }
    return m;
  }, [zones]);

  // Zones per greenhouse — the denominator for "covered N of M".
  const zonesPerGreenhouse = useMemo(() => zonesPerHouse(zones), [zones]);

  // Bed spacing (median gap between neighbouring beds' first zones), so the
  // route can tell a neighbouring bed from a far jump by distance as well as
  // by bed number. Longitude is scaled to metres-ish by cos(latitude).
  const bedWidth = useMemo(() => {
    const first = new Map<string, Pt>();
    bedZones.forEach((zs, bed) => {
      const c = zs.get(1) && geometryCentroid(zs.get(1)!.geometry);
      if (c) first.set(bed, c);
    });
    const gaps: number[] = [];
    first.forEach((pt, bed) => {
      if (gaps.length >= 300) return;
      const m = /^(.*Bed\s+)(\d+)$/i.exec(bed);
      const nb = m && first.get(`${m[1]}${Number(m[2]) + 1}`);
      if (nb) gaps.push(Math.hypot(pt[0] - nb[0], (pt[1] - nb[1]) * Math.cos((pt[0] * Math.PI) / 180)));
    });
    gaps.sort((a, b) => a - b);
    return gaps.length ? gaps[gaps.length >> 1] : 0;
  }, [bedZones]);

  const trails = useMemo(() => {
    const near = (a: Pt, b: Pt) =>
      bedWidth > 0 &&
      Math.hypot(a[0] - b[0], (a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180)) <= 1.5 * bedWidth;
    const geoCache = new Map<string, BedGeometry | undefined>();
    const bedOf = (bed: string): BedGeometry | undefined => {
      if (geoCache.has(bed)) return geoCache.get(bed);
      const zs = bedZones.get(bed);
      let geo: BedGeometry | undefined;
      if (zs) {
        const pts = new Map<number, Pt>();
        zs.forEach((z, n) => {
          const c = geometryCentroid(z.geometry);
          if (c) pts.set(n, c);
        });
        geo = { zoneCount: Math.max(...zs.keys()), point: (n) => pts.get(n) };
      }
      geoCache.set(bed, geo);
      return geo;
    };
    const out: Trail[] = [];
    visitsByScout.forEach((visits, scout) => {
      let cur: ScoutVisit[] = [];
      let prevKey = "";
      const flush = () => {
        if (!cur.length) return;
        const segments = neatRoute(
          cur.map((v) => ({ bed: v.bed, zone: v.zoneNo })),
          bedOf,
          { near },
        );
        const beds: string[] = [];
        for (const v of cur) if (v.bed && !beds.includes(v.bed)) beds.push(v.bed);
        const date = (cur[0].ts || "").slice(0, 10);
        out.push({
          key: `${scout}|${date}|${cur[0].greenhouse}`,
          scout,
          greenhouse: cur[0].greenhouse,
          date,
          segments,
          start: cur[0].centroid,
          end: routeEnd(segments, cur[cur.length - 1].centroid)!,
          zones: new Set(cur.map((v) => v.zone)),
          beds,
          firstTime: (cur[0].ts || "").slice(11),
          lastTime: (cur[cur.length - 1].ts || "").slice(11),
        });
        cur = [];
      };
      for (const v of visits) {
        const key = `${(v.ts || "").slice(0, 10)}|${v.greenhouse}`;
        if (key !== prevKey) flush();
        prevKey = key;
        cur.push(v);
      }
      flush();
    });
    return out;
  }, [visitsByScout, bedZones, bedWidth]);

  // ── Map plumbing. ──
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  function dominantScout(row: ZoneRoll): string | null {
    let bestKey: string | null = null;
    let bestN = -1;
    row.scoutEntries.forEach((n, k) => {
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
    trailLayers.current.clear();
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


    // 2. Neat scout routes. Real-ping stretches are solid; stretches implied by
    //    neatRoute across a 2+ zone gap are dotted. The end node carries the
    //    scout's initials; clicking it or the line opens the route card.
    trailLayers.current.clear();
    trails.forEach((t) => {
      const color = scoutInfo.colorMap.get(t.scout) || "#5BB45D";
      const name = nameOf(t.scout);
      const tip = `<div style="font:11px var(--sd-font),Arial,sans-serif">
                 <b>${escapeHtml(name)}</b><br/>
                 ${escapeHtml(t.greenhouse || "—")} · ${t.zones.size} zones · ${t.date}
               </div>`;
      const open = () => setSelectedTrail(t.key);
      const lines = t.segments.map((seg) =>
        L.polyline(seg.points as L.LatLngExpression[], {
          color,
          weight: 2,
          opacity: ROUTE_OPACITY,
          dashArray: seg.dashed ? "2 6" : undefined,
          lineJoin: "round",
          lineCap: "round",
          bubblingMouseEvents: false,
        })
          .bindTooltip(tip, { sticky: true })
          .on("click", open)
          .addTo(layer),
      );
      // Start dot, so the direction of the walk is clear.
      const startDot = L.circleMarker(t.start, {
        radius: 4,
        color: "#ffffff",
        weight: 2,
        fillColor: color,
        fillOpacity: 1,
        bubblingMouseEvents: false,
      })
        .bindTooltip(`Start · ${t.firstTime || "—"}`, { sticky: true })
        .on("click", open)
        .addTo(layer);
      const badge = L.marker(t.end, {
        icon: badgeIcon(initialsOf(name), color, false),
        bubblingMouseEvents: false,
        keyboard: false,
      })
        .bindTooltip(tip, { direction: "top", offset: [0, -12] })
        .on("click", open)
        .addTo(layer);
      trailLayers.current.set(t.key, { lines, startDot, badge, color, initials: initialsOf(name) });
      for (const seg of t.segments) for (const pt of seg.points) bounds.extend(pt);
    });
    applySelection(selectedRef.current);

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
  }, [aggByZone, zoneByName, trails, scoutInfo, mapSettings, filters.farm, nameOf]);

  // Highlight the open route and dim the rest (all back to normal when none).
  const trailLayers = useRef(
    new Map<
      string,
      { lines: L.Polyline[]; startDot: L.CircleMarker; badge: L.Marker; color: string; initials: string }
    >(),
  );
  const selectedRef = useRef<string | null>(null);
  function applySelection(sel: string | null) {
    trailLayers.current.forEach((t, key) => {
      const on = sel === key;
      const dim = sel != null && !on;
      t.lines.forEach((l) =>
        l.setStyle({ weight: on ? 3.5 : 2, opacity: on ? 0.95 : dim ? 0.12 : ROUTE_OPACITY }),
      );
      t.startDot.setStyle({ opacity: dim ? 0.2 : 1, fillOpacity: dim ? 0.2 : 1 });
      t.badge.setIcon(badgeIcon(t.initials, t.color, on));
      t.badge.setOpacity(dim ? 0.35 : 1);
      t.badge.setZIndexOffset(on ? 1000 : 0);
      if (on) t.lines.forEach((l) => l.bringToFront());
    });
  }
  useEffect(() => {
    selectedRef.current = selectedTrail;
    applySelection(selectedTrail);
  }, [selectedTrail]);


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

  // The open route's card: scout, photo, house, date, coverage, times, beds.
  const openTrail = useMemo<ScoutTrail | null>(() => {
    const t = selectedTrail ? trails.find((x) => x.key === selectedTrail) : null;
    if (!t) return null;
    return {
      key: t.key,
      scoutId: t.scout,
      name: nameOf(t.scout),
      image: scoutImages[t.scout],
      color: scoutInfo.colorMap.get(t.scout) || "#5BB45D",
      greenhouse: t.greenhouse,
      date: t.date,
      zonesCovered: t.zones.size,
      zonesTotal: zonesPerGreenhouse.get(ghOf(t.beds[0] || t.greenhouse)) || 0,
      start: t.firstTime,
      end: t.lastTime,
      beds: t.beds,
    };
  }, [selectedTrail, trails, nameOf, scoutImages, scoutInfo, zonesPerGreenhouse]);

  // Esc closes the route card first, then the zone card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (selectedTrail) setSelectedTrail(null);
      else if (selectedZone) setSelectedZone(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedTrail, selectedZone]);

  // First load (nothing processed yet): the figures are skeletons. A refresh
  // keeps the old figures. A failed load ends the skeletons and says so
  // (below), rather than pulsing on.
  const first = firstLoad(loading || (!data && !error), !!data);

  return (
    <div className="flex flex-col h-svh overflow-hidden">
      <RangeHeader
        title="Scouting"
        subtitle="Up to one week · zones scouted, with repeat-day overlap"
        value={filters}
        onChange={setFilters}
      />

      {/* Inline under the header, not a full-screen overlay (skeleton spec K4):
          the basemap stays visible while the weeks load. */}
      <div className="px-4 md:px-6">
        {error && !data && !loading && (
          <span role="alert" className="text-destructive">{error}</span>
        )}
        <LoadProgress active={loading} progress={progress} />
      </div>

      <div className="relative flex-1 min-h-[55vh] lg:min-h-0" aria-busy={first || undefined}>
        <div className="absolute inset-4 md:inset-6 isolate z-0 overflow-hidden rounded-[20px] border border-border shadow-[var(--sd-shadow-1)]">
          <MapBase
            onReady={(m) => {
              mapRef.current = m;
            }}
          />

          {/* Coverage figures, a quiet pill over the top edge. */}
          <div className="pointer-events-none absolute left-1/2 top-3 z-[1000] -translate-x-1/2 rounded-full border bg-card/95 px-3 py-1 text-[0.7rem] tabular-nums shadow-[var(--sd-shadow-1)] backdrop-blur">
            {first || loading ? (
              <Bar className="h-4 w-40 rounded-full" />
            ) : (
              <>
                {stats.scouts} scouts · {stats.beds} beds · {stats.zones} zones · {stats.entries} entries
                <span className="ml-2 text-muted-foreground">
                  {isSingleDay ? filters.from : `${filters.from} → ${filters.to}`}
                </span>
              </>
            )}
          </div>

          {openTrail ? (
            <ScoutRouteCard
              key={openTrail.key}
              trail={openTrail}
              onClose={() => setSelectedTrail(null)}
              className="absolute right-4 top-14 z-[1000]"
            />
          ) : null}

          {/* Clicked-zone detail, floating bottom-left like the trap card. */}
          {detail ? (
            <Card className="scp-card-in absolute bottom-4 left-4 z-[1000] max-h-[60%] w-[min(320px,calc(100%-2rem))] overflow-auto bg-card/95 p-3 backdrop-blur">
              <CardHeader className="p-0 pb-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-sm">{detail.zone}</CardTitle>
                    <CardDescription className="text-[0.7rem]">
                      {detail.totalEntries} entr
                      {detail.totalEntries === 1 ? "y" : "ies"}
                      {!isSingleDay
                        ? ` · covered ${detail.days.size} of ${rangeDayCount} days`
                        : ""}
                      {detail.lastTs ? ` · last ${detail.lastTs.slice(11)}` : ""}
                    </CardDescription>
                  </div>
                  <button
                    type="button"
                    aria-label="Close zone card"
                    onClick={() => setSelectedZone(null)}
                    className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
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
                {([
                  ["Top Pests", topPests, pestColor],
                  ["Top Diseases", topDiseases, diseaseColor],
                ] as const).map(([title, rows, colourOf]) => (
                  <div key={title}>
                    <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                      {title}
                    </div>
                    {rows.length ? (
                      rows.map(([name, count]) => (
                        <div
                          key={name}
                          className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-[var(--sd-bg-soft)] mb-1"
                        >
                          <span
                            className="h-2.5 w-2.5 rounded-full border shrink-0"
                            style={{ background: colourOf(name) }}
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
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
