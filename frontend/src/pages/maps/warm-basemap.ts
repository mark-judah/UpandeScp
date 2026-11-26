/**
 * Warm the browser's HTTP cache with the basemap tiles under a farm, so moving around the farm
 * never waits on them. OpenFreeMap's vector tiles stop at z14 (deeper views overzoom them) and are
 * served with a ten-year cache lifetime, so a farm needs a few dozen tiles at most; we cap it anyway.
 * OpenFreeMap: free, no registration, no request limits.
 */
import type maplibregl from "maplibre-gl";
import { tilesForBox, type BBox } from "@/lib/field-geo";

export const WARM_MAX_TILES = 200;
const MARGIN = 0.15; // of the farm's width / height on each side

/** The tile URLs to warm for ``box`` (plus a margin), zooms 12..maxzoom, at most ``cap``. Pure. */
export function basemapTileUrls(template: string, box: BBox, minzoom: number, maxzoom: number, cap = WARM_MAX_TILES): string[] {
  const mx = (box[2] - box[0]) * MARGIN;
  const my = (box[3] - box[1]) * MARGIN;
  const b: BBox = [box[0] - mx, box[1] - my, box[2] + mx, box[3] + my];
  const out: string[] = [];
  for (let z = Math.max(12, minzoom); z <= Math.min(maxzoom, 19); z++) {
    const tiles = tilesForBox(b, z);
    if (out.length + tiles.length > cap) break;
    for (const [x, y] of tiles) out.push(template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)));
  }
  return out;
}

/** Fetch (a few at a time, in the background) the tiles of every tiled source in the style. */
export function warmBasemapTiles(map: maplibregl.Map, box: BBox): Promise<number> {
  const urls: string[] = [];
  for (const id of Object.keys(map.getStyle()?.sources ?? {})) {
    const src = map.getSource(id) as unknown as { tiles?: string[]; minzoom?: number; maxzoom?: number; type?: string } | undefined;
    if (!src || (src.type !== "vector" && src.type !== "raster") || !src.tiles?.length) continue;
    urls.push(...basemapTileUrls(src.tiles[0], box, src.minzoom ?? 0, src.maxzoom ?? 14));
  }
  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        await fetch(u, { mode: "cors", credentials: "omit" });
      } catch {
        /* a tile that cannot be fetched now will be fetched when it is needed */
      }
    }
  };
  return Promise.all([worker(), worker(), worker()]).then(() => urls.length);
}
