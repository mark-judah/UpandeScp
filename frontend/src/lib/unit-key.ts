import type { ScoutingEntry } from "@/lib/scouting-types";

/** (0,0) is the Atlantic: a missing coordinate, not a place. */
export function entryPoint(e: Pick<ScoutingEntry, "latitude" | "longitude">): [number, number] | null {
  const lat = typeof e.latitude === "number" ? e.latitude : parseFloat(String(e.latitude ?? ""));
  const lng = typeof e.longitude === "number" ? e.longitude : parseFloat(String(e.longitude ?? ""));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return null;
  return [lng, lat];
}

export const POINT_PREFIX = "pt:";

/**
 * What an entry coloured: the orchard tree, else the hexagon (triad), else - for blocks that
 * have an outline but no trees or hexagons yet - the visit point itself. "" when the entry has
 * nowhere on the map.
 */
export function unitKey(e: ScoutingEntry): string {
  if (e.tree) return e.tree;
  if (e.triad) return e.triad;
  return entryPoint(e) ? `${POINT_PREFIX}${e.name}` : "";
}
