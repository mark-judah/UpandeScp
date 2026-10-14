/**
 * Shared drawing kit for the "one map format" pages that show people walking
 * through zones (Rose Scouting, Spraying): the soft zone fill, neat routes with
 * a start dot and an initials badge, and the open-route highlight. The pages
 * own their data; this owns how it looks, so the two stay the same map.
 */
import { useMemo } from "react";
import L from "leaflet";
import { desaturate, levelAlpha, levelOf, paperFor } from "@/lib/heat-style";
import { geometryCentroid, houseOf, type ZoneFeature } from "./zone-utils";
import {
  neatRoute,
  zoneNumber,
  type BedGeometry,
  type Pt,
  type RouteSegment,
} from "./neat-route";

/** Route line opacity at rest (dimmed/raised while a route card is open). */
export const ROUTE_OPACITY = 0.42;
export const ROUTE_WEIGHT = 1.5;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Soft zone look: hairline outline, a desaturated fill whose depth follows
 *  the zone's visit count through the level ramp. */
export function zoneHeatStyle(color: string, count: number): L.PathOptions {
  return {
    color: "#8a8780",
    weight: 0.5,
    opacity: 0.35,
    fillColor: desaturate(color, paperFor()),
    fillOpacity: levelAlpha(levelOf(count)),
  };
}

/** The person's initials in a small circle of their colour, at the route's end. */
export function badgeIcon(initials: string, color: string, selected: boolean): L.DivIcon {
  const size = selected ? 30 : 24;
  return L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:9999px;background:${color};color:#fff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;font:600 ${selected ? 11 : 9}px var(--sd-font),Poppins,Arial,sans-serif;letter-spacing:.02em">${escapeHtml(initials)}</div>`,
  });
}

export interface RouteVisit {
  bed: string;
  zoneNo: number;
}

/**
 * Bed geometry + neat-route runner for the loaded zones. `neat(visits)` takes
 * one walk (bed/zone number plus the zone centroid) and returns the closed-up
 * route segments.
 */
export function useBedRouter(zones: ZoneFeature[]) {
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

  // Bed spacing (median gap between neighbouring beds' first zones), so the
  // route can tell a neighbouring bed from a far jump by distance as well as
  // by bed number. Longitude is scaled by cos(latitude).
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

  return useMemo(() => {
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
    return {
      neat: (visits: RouteVisit[]): RouteSegment[] =>
        neatRoute(visits.map((v) => ({ bed: v.bed, zone: v.zoneNo })), bedOf, { near }),
    };
  }, [bedZones, bedWidth]);
}

/** The Leaflet layers of one drawn route. */
export interface TrailLayer {
  lines: L.Polyline[];
  startDot: L.CircleMarker;
  badge: L.Marker;
  color: string;
  initials: string;
  showBadge: boolean;
}

export interface DrawnTrail {
  key: string;
  person: string;
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

/**
 * One badge per person: on their latest trail (per greenhouse once a greenhouse
 * is picked). A week at farm level is many houses per person, and a badge on
 * every trail buries the map. Other trails stay clickable by their line and
 * show their badge while open.
 */
export function latestTrails<T extends DrawnTrail>(trails: T[], oneHouse: boolean) {
  const keyOf = (t: T) => (oneHouse ? `${t.person}|${t.greenhouse}` : t.person);
  const latest = new Map<string, T>();
  for (const t of trails) {
    const k = keyOf(t);
    const prev = latest.get(k);
    if (!prev || `${t.date} ${t.lastTime}` > `${prev.date} ${prev.lastTime}`) latest.set(k, t);
  }
  return (t: T) => latest.get(keyOf(t)) === t;
}

/** Draw a neat route: solid real-ping stretches, dotted implied ones, a start
 *  dot and the initials badge. Clicking any of them calls `onOpen`. */
export function drawTrail(
  layer: L.LayerGroup,
  t: DrawnTrail,
  o: { color: string; initials: string; tipHtml: string; showBadge: boolean; onOpen: () => void },
): TrailLayer {
  // Calm routes: desaturated colour, thin; the badge keeps the full colour.
  const routeColor = desaturate(o.color, paperFor(), 0.72);
  const lines = t.segments.map((seg) =>
    L.polyline(seg.points as L.LatLngExpression[], {
      color: routeColor,
      weight: ROUTE_WEIGHT,
      opacity: ROUTE_OPACITY,
      dashArray: seg.dashed ? "2 6" : undefined,
      lineJoin: "round",
      lineCap: "round",
      bubblingMouseEvents: false,
    })
      .on("click", o.onOpen)
      .addTo(layer),
  );
  const startDot = L.circleMarker(t.start, {
    radius: 4,
    color: "#ffffff",
    weight: 2,
    fillColor: o.color,
    fillOpacity: 1,
    bubblingMouseEvents: false,
  })
    .bindTooltip(`Start · ${t.firstTime || "—"}`, { direction: "top" })
    .on("click", o.onOpen)
    .addTo(layer);
  const badge = L.marker(t.end, {
    icon: badgeIcon(o.initials, o.color, false),
    bubblingMouseEvents: false,
    keyboard: false,
  })
    .bindTooltip(o.tipHtml, { direction: "top", offset: [0, -12] })
    .on("click", o.onOpen);
  if (o.showBadge) badge.addTo(layer);
  return { lines, startDot, badge, color: o.color, initials: o.initials, showBadge: o.showBadge };
}

/** Highlight the open route and dim the rest (all back to normal when none). */
export function applyTrailSelection(
  trailLayers: Map<string, TrailLayer>,
  layer: L.LayerGroup | null,
  sel: string | null,
) {
  trailLayers.forEach((t, key) => {
    const on = sel === key;
    const dim = sel != null && !on;
    t.lines.forEach((l) =>
      l.setStyle({ weight: on ? 3 : ROUTE_WEIGHT, opacity: on ? 0.9 : dim ? 0.1 : ROUTE_OPACITY }),
    );
    t.startDot.setStyle({ opacity: dim ? 0.2 : 1, fillOpacity: dim ? 0.2 : 1 });
    t.badge.setIcon(badgeIcon(t.initials, t.color, on));
    t.badge.setOpacity(dim ? 0.35 : 1);
    t.badge.setZIndexOffset(on ? 1000 : 0);
    // An earlier day's trail has no badge of its own; show it while open.
    if (layer && !t.showBadge) {
      if (on) t.badge.addTo(layer);
      else t.badge.remove();
    }
    if (on) t.lines.forEach((l) => l.bringToFront());
  });
}

/** Every greenhouse one person covered in the range: distinct zones over the
 *  house's zones, all days together, best covered first. */
export function housesCovered(
  trails: DrawnTrail[],
  person: string,
  zonesPerGreenhouse: Map<string, number>,
) {
  const byHouse = new Map<string, Set<string>>();
  for (const x of trails) {
    if (x.person !== person) continue;
    const gh = houseOf(x.beds[0] || x.greenhouse);
    let z = byHouse.get(gh);
    if (!z) byHouse.set(gh, (z = new Set()));
    x.zones.forEach((zone) => z!.add(zone));
  }
  return [...byHouse.entries()]
    .map(([greenhouse, zones]) => {
      const total = zonesPerGreenhouse.get(greenhouse) || 0;
      return {
        greenhouse,
        covered: zones.size,
        total,
        pct: total ? Math.min(100, Math.round((zones.size / total) * 100)) : 0,
      };
    })
    .sort((a, b) => b.pct - a.pct || a.greenhouse.localeCompare(b.greenhouse));
}
