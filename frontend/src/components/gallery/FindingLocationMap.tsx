/**
 * Visual findings ▸ the location map: the greenhouse's beds drawn with the
 * existing BedSvg, the finding's bed / zone marked in the observation's colour
 * with a pulse. `size="large"` fills its parent (the viewer's Location tab,
 * which adds zoom / pan and a caption) and says so when the house has no bed
 * geometry; `size="mini"` is the old 150px inline thumbnail that links to the
 * Heatmaps page and renders nothing without geometry. Geometry is fetched
 * lazily (the cached `fetchBedsAndZones`) and projected once per greenhouse.
 * Avocado findings have no bed: they get the block's outline, every tree as a
 * grey dot and the finding's tree (else its trap, else the block) pulsing.
 */
import { useEffect, useState } from "react";
import { MapPinOff } from "lucide-react";
import { formatFindingPlace } from "@/lib/finding-place";
import { BedSvg, type BedMarker } from "@/pages/maps/BedSvg";
import { projectGeometry, type ProjectedGeometry, type ZoneGeoLike } from "@/pages/maps/bed-projection";
import { flattenZones, houseOf } from "@/pages/maps/zone-utils";
import {
  fetchBedsAndZones, fetchBlocksGeojson, fetchOrchardTreeRows, fetchTrapLocations, type TrapLocations,
} from "@/lib/scouting-api";
import { projectFromUnproject } from "@/lib/geo-project";
import { observationColor } from "@/lib/observation-colors";
import { cropSlug } from "@/lib/router";
import { isBlockGrown } from "@/lib/crop-profile";
import type { FeedPhoto } from "@/lib/gallery-api";
import { decodeHexes, fetchFieldLayers, type HexSet } from "@/lib/field-geo";
import { entryPoint } from "@/lib/unit-key";

const cache = new Map<string, Promise<ProjectedGeometry | null>>();

/** Projected bed geometry of one greenhouse, cached per house. */
export function loadHouseGeometry(house: string): Promise<ProjectedGeometry | null> {
  let hit = cache.get(house);
  if (!hit) {
    hit = fetchBedsAndZones()
      .then((vs) => {
        const zones: ZoneGeoLike[] = flattenZones(vs)
          .filter((z) => z.geometry && houseOf(z.bedName) === house)
          .map((z) => ({ name: z.zoneName, raw_geojson: z.geometry }));
        return zones.length ? projectGeometry(zones) : null;
      })
      .catch(() => {
        cache.delete(house);
        return null;
      });
    cache.set(house, hit);
  }
  return hit;
}
export const clearHouseGeometryCache = () => {
  cache.clear();
  blockCache.clear();
  hexCache = null;
  trapCache = null;
};

let trapCache: Promise<TrapLocations> | null = null;
/** Every trap's fixed location (Trap.geojson), fetched once. */
export function loadTrapLocations(): Promise<TrapLocations> {
  return (trapCache ??= fetchTrapLocations());
}

/** The zones to mark: the named zone, else every zone of the finding's bed. */
export function findingZones(g: ProjectedGeometry, p: Pick<FeedPhoto, "zone" | "bed" | "greenhouse" | "house">): string[] {
  const names = Object.keys(g.zoneCentroids);
  const exact = names.filter((n) => n === p.zone || n.endsWith(` - ${p.zone}`));
  if (p.zone && exact.length) return exact;
  if (p.bed) return names.filter((n) => new RegExp(` - Bed ${p.bed}(?: - |$)`).test(n));
  return [];
}

/** Heatmaps deep link for a finding (gh / obs / kind params). */
export function heatmapsHref(p: Pick<FeedPhoto, "greenhouse" | "house" | "subject" | "kind">, crop?: string): string {
  const house = p.greenhouse || p.house || "";
  return `#/${cropSlug(crop || "Rose")}/heatmaps?gh=${encodeURIComponent(house)}&obs=${encodeURIComponent(p.subject)}&kind=${p.kind}`;
}

/** A trap's SVG position (percent of the drawing) from its fixed location. */
export function trapSpot(
  g: ProjectedGeometry,
  loc: { lat: number; lng: number } | undefined | null,
): { x: number; y: number; outside: boolean } | null {
  if (!loc || !g.unproject) return null;
  const project = projectFromUnproject(g.unproject);
  if (!project) return null;
  const [sx, sy] = project(loc.lng, loc.lat);
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  const x = (sx / g.width) * 100, y = (sy / g.height) * 100;
  const outside = x < 0 || x > 100 || y < 0 || y > 100;
  return { x: Math.min(100, Math.max(0, x)), y: Math.min(100, Math.max(0, y)), outside };
}

/** The pulsing marker (and, for a trap, its dot + label) over a drawing. */
function SpotPulse({
  spot, color, large, trap,
}: { spot: { x: number; y: number } | null; color: string; large: boolean; trap?: string }) {
  if (!spot) return null;
  return (
    <>
      <span
        aria-hidden
        data-testid="finding-map-pulse"
        className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 motion-reduce:animate-none ${large ? "h-8 w-8 border-[3px]" : "h-4 w-4"}`}
        style={{ left: `${spot.x}%`, top: `${spot.y}%`, borderColor: color }}
      />
      {trap ? (
        <>
          <span
            aria-hidden
            className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full ${large ? "h-3 w-3" : "h-2 w-2"}`}
            style={{ left: `${spot.x}%`, top: `${spot.y}%`, background: color }}
          />
          {large ? (
            <span
              data-testid="finding-map-trap-label"
              className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-2 py-0.5 text-[0.7rem] font-medium text-white"
              style={{ left: `${spot.x}%`, top: `calc(${spot.y}% + 1.1rem)` }}
            >
              Trap {trap}
            </span>
          ) : null}
        </>
      ) : null}
    </>
  );
}

const avocadoCrop = (crop?: string) => isBlockGrown(cropSlug(crop || ""));

/** Block-grown findings (avocado, pivot vegetables) are placed by block + tree; roses by greenhouse + bed. */
export function FindingLocationMap(props: { photo: FeedPhoto; crop?: string; size?: "mini" | "large" }) {
  const p = props.photo;
  return avocadoCrop(props.crop) || (!(p.greenhouse || p.house) && p.block) ? (
    <BlockLocationMap {...props} />
  ) : (
    <HouseLocationMap {...props} />
  );
}

// ---- Avocado: block outline + trees -------------------------------------

export interface ProjectedBlock {
  width: number;
  height: number;
  /** Outline rings as SVG path data. */
  path: string;
  /** Tree-name key -> position in the drawing (percent). */
  trees: { key: string; x: number; y: number }[];
  /** Every hexagon (Triad) of the block as one SVG path, and each one's centre (percent). */
  hexPath: string;
  triads: Map<string, { x: number; y: number }>;
  centroid: { x: number; y: number };
  /** lng/lat -> position in the drawing (percent, unclamped). */
  at: (lng: number, lat: number) => { x: number; y: number };
}

/** "Row 13 - Tree 1" (scouting) and "..._ROW13_T1" (orchard master) are the
 *  same tree: compare them as row:tree, else by the plain name. */
export function treeKey(name: string): string {
  const n = (name || "").trim();
  const m = /row[\s_]*(\d+)[\s_-]*(?:tree|t)[\s_]*(\d+)$/i.exec(n);
  return m ? `${Number(m[1])}:${Number(m[2])}` : n.toLowerCase();
}

type Ring = number[][];
const ringsOf = (g: { type?: string; coordinates?: unknown } | null | undefined): Ring[] => {
  if (!g || !Array.isArray(g.coordinates)) return [];
  if (g.type === "Polygon") return g.coordinates as Ring[];
  if (g.type === "MultiPolygon") return (g.coordinates as Ring[][]).flat();
  return [];
};

const blockCache = new Map<string, Promise<ProjectedBlock | null>>();
let hexCache: Promise<HexSet> | null = null;
/** Every hexagon on the farms, decoded once (the payload is the compact, versioned one). */
function fieldHexes(): Promise<HexSet> {
  return (hexCache ??= fetchFieldLayers("").then((r) => decodeHexes(r.hex)));
}
/** Projected outline + trees of one block (equirectangular, fitted to the outline), cached. */
export function loadBlockGeometry(block: string): Promise<ProjectedBlock | null> {
  let hit = blockCache.get(block);
  if (!hit) {
    hit = Promise.all([
      fetchBlocksGeojson(),
      fetchOrchardTreeRows({ block }),
      fieldHexes().catch(() => null),
    ])
      .then(([fc, pts, hexes]) => {
        const rings = (fc?.features || [])
          .filter((f) => (f.properties as { block?: string } | null)?.block === block)
          .flatMap((f) => ringsOf(f.geometry as never))
          .filter((r) => r.length >= 3);
        if (!rings.length) return null;
        const all = rings.flat();
        const lat0 = all.reduce((s, c) => s + c[1], 0) / all.length;
        const k = Math.cos((lat0 * Math.PI) / 180);
        const xs = all.map((c) => c[0] * k), ys = all.map((c) => -c[1]);
        const minX = Math.min(...xs), minY = Math.min(...ys);
        const w = Math.max(...xs) - minX || 1e-9, h = Math.max(...ys) - minY || 1e-9;
        const W = 1000, H = Math.max(1, Math.round((W * h) / w));
        const proj = (lng: number, lat: number) => ({
          x: ((lng * k - minX) / w) * 100,
          y: ((-lat - minY) / h) * 100,
        });
        const px = (c: number[]) => {
          const q = proj(c[0], c[1]);
          return `${((q.x / 100) * W).toFixed(1)} ${((q.y / 100) * H).toFixed(1)}`;
        };
        const path = rings.map((r) => `M${r.map(px).join("L")}Z`).join("");
        const triads = new Map<string, { x: number; y: number }>();
        const hexPath: string[] = [];
        for (const f of hexes?.fc.features ?? []) {
          if (f.properties.b !== block) continue;
          const ring = f.geometry.coordinates[0];
          hexPath.push(`M${ring.map(px).join("L")}Z`);
          const mid = proj(
            (Math.min(...ring.map((c) => c[0])) + Math.max(...ring.map((c) => c[0]))) / 2,
            (Math.min(...ring.map((c) => c[1])) + Math.max(...ring.map((c) => c[1]))) / 2,
          );
          triads.set(f.properties.n, mid);
        }
        const trees = pts.names.map((n, i) => ({ key: treeKey(n), ...proj(pts.coords[i * 2], pts.coords[i * 2 + 1]) }));
        const cx = all.reduce((s, c) => s + c[0], 0) / all.length;
        return { width: W, height: H, path, trees, hexPath: hexPath.join(""), triads, centroid: proj(cx, lat0), at: proj };
      })
      .catch(() => {
        blockCache.delete(block);
        return null;
      });
    blockCache.set(block, hit);
  }
  return hit;
}

function BlockLocationMap({
  photo: p, crop, size = "mini",
}: { photo: FeedPhoto; crop?: string; size?: "mini" | "large" }) {
  const large = size === "large";
  const [geom, setGeom] = useState<ProjectedBlock | null | undefined>(undefined);
  const [traps, setTraps] = useState<TrapLocations | null | undefined>(p.trap ? undefined : null);
  useEffect(() => {
    let live = true;
    setGeom(undefined);
    if (!p.block) {
      setGeom(null);
      return;
    }
    loadBlockGeometry(p.block).then((g) => live && setGeom(g));
    return () => {
      live = false;
    };
  }, [p.block]);
  useEffect(() => {
    let live = true;
    if (!p.trap) {
      setTraps(null);
      return;
    }
    setTraps(undefined);
    loadTrapLocations().then((t) => live && setTraps(t), () => live && setTraps({}));
    return () => {
      live = false;
    };
  }, [p.trap]);

  if (geom === undefined || traps === undefined) {
    return (
      <div
        data-testid="finding-map-skeleton"
        className={large ? "h-full w-full animate-pulse bg-white/5" : "h-[140px] animate-pulse rounded-xl bg-muted/60"}
      />
    );
  }
  if (!geom) {
    if (!large) return null;
    return (
      <div data-testid="finding-map-empty" className="grid h-full w-full place-items-center p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-2">
          <MapPinOff className="h-8 w-8 text-white/50" aria-hidden />
          <p className="text-sm font-medium text-white">No block map for this finding yet</p>
          {formatFindingPlace(p) ? <p className="text-xs text-white/60">Where: {formatFindingPlace(p)}</p> : null}
        </div>
      </div>
    );
  }
  const kind = p.kind === "disease" ? "disease" : "pest";
  const color = observationColor(p.subject, kind);
  const ratio = geom.width / geom.height;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));

  // What to pulse: the finding's tree, else its trap's fixed position, else the block.
  let spot: { x: number; y: number } | null = null;
  let note = "";
  const key = p.tree ? treeKey(p.tree) : "";
  const tree = key ? geom.trees.find((t) => t.key === key) : undefined;
  const loc = p.trap ? traps?.[p.trap] : undefined;
  const hex = p.triad ? geom.triads.get(p.triad) : undefined;
  const at = entryPoint({ latitude: p.latitude, longitude: p.longitude });
  if (tree) spot = tree;
  else if (hex) spot = hex;
  else if (at && !p.trap) {
    const q = geom.at(at[0], at[1]);
    spot = { x: clamp(q.x), y: clamp(q.y) };
  } else if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    const q = geom.at(loc.lng, loc.lat);
    spot = { x: clamp(q.x), y: clamp(q.y) };
    if (q.x < 0 || q.x > 100 || q.y < 0 || q.y > 100) note = "Trap sits outside the block";
  } else {
    spot = geom.centroid;
    note = p.trap ? "Trap position not mapped" : "Tree not mapped";
  }
  // The trap's dot + label only when it is the trap being shown.
  const showTrap = !tree && !!p.trap && !!loc;
  const svg = (
    <svg viewBox={`0 0 ${geom.width} ${geom.height}`} className="pointer-events-none h-full w-full" aria-hidden>
      <path d={geom.path} fill="none" stroke="currentColor" strokeWidth={large ? 3 : 4} className="text-muted-foreground/60" />
      {geom.hexPath ? (
        <path d={geom.hexPath} fill="none" stroke="currentColor" strokeWidth={large ? 0.6 : 0.8} className="text-muted-foreground/30" data-testid="block-hexes" />
      ) : null}
      {geom.trees.map((t, i) => (
        <circle
          key={i}
          data-testid="block-tree-dot"
          cx={(t.x / 100) * geom.width}
          cy={(t.y / 100) * geom.height}
          r={large ? 2.2 : 3}
          className="fill-muted-foreground/40"
        />
      ))}
    </svg>
  );
  const pulse = <SpotPulse spot={spot} color={color} large={large} trap={showTrap ? p.trap : undefined} />;
  const noteEl = note && large ? (
    <span data-testid="finding-map-note" className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-[0.7rem] text-white">
      {note}
    </span>
  ) : null;
  if (large) {
    return (
      <div className="grid h-full w-full place-items-center" style={{ containerType: "size" }}>
        <div
          data-testid="finding-map"
          data-size="large"
          className="relative rounded-xl bg-[var(--sd-bg-soft)]"
          style={{ aspectRatio: `${geom.width} / ${geom.height}`, width: `min(100cqw, calc(100cqh * ${ratio}))` }}
        >
          {svg}
          {pulse}
          {noteEl}
        </div>
      </div>
    );
  }
  return (
    <a
      href={`#/${cropSlug(crop || "Avocado")}/heatmaps`}
      data-testid="finding-map"
      aria-label={`Show ${p.block} on the heatmap`}
      className="relative mx-auto block overflow-hidden rounded-xl border bg-[var(--sd-bg-soft)]"
      style={{ aspectRatio: `${geom.width} / ${geom.height}`, maxHeight: 150, maxWidth: "100%" }}
    >
      {svg}
      {pulse}
    </a>
  );
}

// ---- Rose: greenhouse beds ----------------------------------------------

function HouseLocationMap({
  photo: p, crop, size = "mini",
}: { photo: FeedPhoto; crop?: string; size?: "mini" | "large" }) {
  const large = size === "large";
  const house = p.greenhouse || p.house;
  const [geom, setGeom] = useState<ProjectedGeometry | null | undefined>(undefined);
  const [traps, setTraps] = useState<TrapLocations | null | undefined>(p.trap ? undefined : null);
  useEffect(() => {
    let live = true;
    setGeom(undefined);
    if (!house) {
      setGeom(null);
      return;
    }
    loadHouseGeometry(house).then((g) => live && setGeom(g));
    return () => {
      live = false;
    };
  }, [house]);
  useEffect(() => {
    let live = true;
    if (!p.trap) {
      setTraps(null);
      return;
    }
    setTraps(undefined);
    loadTrapLocations().then((t) => live && setTraps(t), () => live && setTraps({}));
    return () => {
      live = false;
    };
  }, [p.trap]);

  const href = heatmapsHref(p, crop);
  if (geom === undefined || traps === undefined) {
    return (
      <div
        data-testid="finding-map-skeleton"
        className={large ? "h-full w-full animate-pulse bg-white/5" : "h-[140px] animate-pulse rounded-xl bg-muted/60"}
      />
    );
  }
  if (!geom) {
    // Mini: the panel's Where row already names the place. Large: say so.
    if (!large) return null;
    return (
      <div data-testid="finding-map-empty" className="grid h-full w-full place-items-center p-6 text-center">
        <div className="flex max-w-sm flex-col items-center gap-2">
          <MapPinOff className="h-8 w-8 text-white/50" aria-hidden />
          <p className="text-sm font-medium text-white">No bed map for this block yet</p>
          {formatFindingPlace(p) ? <p className="text-xs text-white/60">Where: {formatFindingPlace(p)}</p> : null}
        </div>
      </div>
    );
  }
  const zones = findingZones(geom, p);
  const kind = p.kind === "disease" ? "disease" : "pest";
  const color = observationColor(p.subject, kind);
  const markers: BedMarker[] = zones.map((zone) => ({ zone, color, kind, count: 1 }));
  const ratio = geom.width / geom.height;
  const nBeds = geom.beds.length;

  // What to pulse: the trap's fixed position, else the bed / zone centroid.
  let spot: { x: number; y: number } | null = null;
  let note = "";
  const trapAt = p.trap ? trapSpot(geom, traps?.[p.trap]) : null;
  if (p.trap) {
    if (trapAt) {
      spot = trapAt;
      if (trapAt.outside) note = "Trap sits outside the house";
    } else note = "Trap position not mapped";
  } else if (zones.length) {
    const pts = zones.map((z) => geom.zoneCentroids[z]);
    spot = {
      x: (pts.reduce((s, c) => s + c.cx, 0) / pts.length / geom.width) * 100,
      y: (pts.reduce((s, c) => s + c.cy, 0) / pts.length / geom.height) * 100,
    };
  } else note = "Bed not recorded for this finding";
  const pulse = <SpotPulse spot={spot} color={color} large={large} trap={p.trap} />;
  const noteEl = note && large ? (
    <span data-testid="finding-map-note" className="pointer-events-none absolute left-2 top-2 rounded-full bg-black/60 px-2.5 py-1 text-[0.7rem] text-white">
      {note}
    </span>
  ) : null;
  if (large) {
    // The parent is a size container: fit the drawing's aspect ratio inside it.
    return (
      <div className="grid h-full w-full place-items-center" style={{ containerType: "size" }}>
        <div
          data-testid="finding-map"
          data-size="large"
          className="relative rounded-xl bg-[var(--sd-bg-soft)]"
          style={{ aspectRatio: `${geom.width} / ${geom.height}`, width: `min(100cqw, calc(100cqh * ${ratio}))` }}
        >
          <BedSvg
            geometry={geom}
            markers={markers}
            labelEvery={nBeds > 60 ? 3 : nBeds > 30 ? 2 : 1}
            labelFontSize={4}
            className="pointer-events-none h-full w-full"
          />
          {pulse}
          {noteEl}
        </div>
      </div>
    );
  }
  // Mini: nothing to point at, so leave the place to the Where row.
  if (!spot) return null;
  return (
    <a
      href={href}
      data-testid="finding-map"
      aria-label={`Show ${house} on the heatmap`}
      className="relative mx-auto block overflow-hidden rounded-xl border bg-[var(--sd-bg-soft)]"
      style={{ aspectRatio: `${geom.width} / ${geom.height}`, maxHeight: 150, maxWidth: "100%" }}
    >
      <BedSvg geometry={geom} markers={markers} labelEvery={1000} className="pointer-events-none h-full w-full" />
      {pulse}
    </a>
  );
}
