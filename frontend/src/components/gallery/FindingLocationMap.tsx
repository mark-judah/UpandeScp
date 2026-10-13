/**
 * Visual findings ▸ the panel's location map: the greenhouse's beds drawn with
 * the existing BedSvg, the finding's bed / zone marked in the observation's
 * colour with a small pulse. About 150px tall, not interactive; a click opens
 * the Heatmaps page for the crop. Geometry is fetched lazily (the cached
 * `fetchBedsAndZones`) and projected once per greenhouse. A house with no bed
 * geometry (avocado blocks, trees) leaves the place to the Where row.
 */
import { useEffect, useState } from "react";
import { BedSvg, type BedMarker } from "@/pages/maps/BedSvg";
import { projectGeometry, type ProjectedGeometry, type ZoneGeoLike } from "@/pages/maps/bed-projection";
import { flattenZones, houseOf } from "@/pages/maps/zone-utils";
import { fetchBedsAndZones } from "@/lib/scouting-api";
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
export const clearHouseGeometryCache = () => cache.clear();

/** The zones to mark: the named zone, else every zone of the finding's bed. */
export function findingZones(g: ProjectedGeometry, p: Pick<FeedPhoto, "zone" | "bed" | "greenhouse" | "house">): string[] {
  const names = Object.keys(g.zoneCentroids);
  const exact = names.filter((n) => n === p.zone || n.endsWith(` - ${p.zone}`));
  if (p.zone && exact.length) return exact;
  if (p.bed) return names.filter((n) => new RegExp(` - Bed ${p.bed}(?: - |$)`).test(n));
  return [];
}

export function FindingLocationMap({ photo: p, crop }: { photo: FeedPhoto; crop?: string }) {
  const house = p.greenhouse || p.house;
  const [geom, setGeom] = useState<ProjectedGeometry | null | undefined>(undefined);
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

  const href = `#/${cropSlug(crop || "Rose")}/heatmaps?gh=${encodeURIComponent(house)}&obs=${encodeURIComponent(p.subject)}&kind=${p.kind}`;
  if (geom === undefined) {
    return <div data-testid="finding-map-skeleton" className="h-[140px] animate-pulse rounded-xl bg-muted/60" />;
  }
  const zones = geom ? findingZones(geom, p) : [];
  // No bed geometry (avocado blocks, trees): the panel's Where row already names the place.
  if (!geom || !zones.length) return null;
  const color = observationColor(p.subject, p.kind === "disease" ? "disease" : "pest");
  const markers: BedMarker[] = zones.map((zone) => ({ zone, color, kind: p.kind === "disease" ? "disease" : "pest", count: 1 }));
  const pts = zones.map((z) => geom.zoneCentroids[z]);
  const cx = pts.reduce((s, c) => s + c.cx, 0) / pts.length;
  const cy = pts.reduce((s, c) => s + c.cy, 0) / pts.length;
  return (
    <a
      href={href}
      data-testid="finding-map"
      aria-label={`Show ${house} on the heatmap`}
      className="relative mx-auto block overflow-hidden rounded-xl border bg-[var(--sd-bg-soft)]"
      style={{ aspectRatio: `${geom.width} / ${geom.height}`, maxHeight: 150, maxWidth: "100%" }}
    >
      <BedSvg geometry={geom} markers={markers} labelEvery={1000} className="pointer-events-none h-full w-full" />
      <span
        aria-hidden
        data-testid="finding-map-pulse"
        className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border-2 motion-reduce:animate-none"
        style={{ left: `${(cx / geom.width) * 100}%`, top: `${(cy / geom.height) * 100}%`, borderColor: color }}
      />
    </a>
  );
}
