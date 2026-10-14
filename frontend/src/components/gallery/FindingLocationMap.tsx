/**
 * Visual findings ▸ the location map: the greenhouse's beds drawn with the
 * existing BedSvg, the finding's bed / zone marked in the observation's colour
 * with a pulse. `size="large"` fills its parent (the viewer's Location tab,
 * which adds zoom / pan and a caption) and says so when the house has no bed
 * geometry; `size="mini"` is the old 150px inline thumbnail that links to the
 * Heatmaps page and renders nothing without geometry. Geometry is fetched
 * lazily (the cached `fetchBedsAndZones`) and projected once per greenhouse.
 */
import { useEffect, useState } from "react";
import { MapPinOff } from "lucide-react";
import { formatFindingPlace } from "@/lib/finding-place";
import { BedSvg, type BedMarker } from "@/pages/maps/BedSvg";
import { projectGeometry, type ProjectedGeometry, type ZoneGeoLike } from "@/pages/maps/bed-projection";
import { flattenZones, houseOf } from "@/pages/maps/zone-utils";
import { fetchBedsAndZones, fetchTrapLocations, type TrapLocations } from "@/lib/scouting-api";
import { projectFromUnproject } from "@/lib/geo-project";
import { observationColor } from "@/lib/observation-colors";
import { cropSlug } from "@/lib/router";
import type { FeedPhoto } from "@/lib/gallery-api";

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

export function FindingLocationMap({
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
  const pulse = spot ? (
    <>
      <span
        aria-hidden
        data-testid="finding-map-pulse"
        className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 motion-reduce:animate-none ${large ? "h-8 w-8 border-[3px]" : "h-4 w-4"}`}
        style={{ left: `${spot.x}%`, top: `${spot.y}%`, borderColor: color }}
      />
      {p.trap ? (
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
              Trap {p.trap}
            </span>
          ) : null}
        </>
      ) : null}
    </>
  ) : null;
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
