/**
 * Traps on the unit they hang on (spec 2026-10-29 §4). A trap with a unit (Trap.unit) carries the
 * unit's geometry from get_trap_locations: a hexagon is outlined, a bed / row is drawn as its line,
 * and a tree (a point) or a trap with no unit gets a ring at its point. Every trap is labelled with
 * its number at the trap's point (the unit's centre). Pure: the page hands the result to MapLibre.
 */
import type { GeoJsonFC, TrapLocations } from "./scouting-api";

/** Outline colour of a trap that caught nothing in the window. */
export const TRAP_IDLE = "#3a3a34";

/** "Mutara - T04" → "T04" when the trap has no number of its own. */
const numberOf = (trap: string, n?: string) => (n && n.trim()) || trap.split(" - ").pop() || trap;

export interface TrapUnitLayers {
  /** Hexagons (Polygon) and beds (LineString), one per trap. */
  outlines: GeoJsonFC;
  /** Point units (a tree) and traps with no unit: a ring at the point. */
  rings: GeoJsonFC;
  /** The trap number at the trap's point. */
  labels: GeoJsonFC;
}

/** Map layers for the traps; `colors` = trap → its pest colour when it caught something. */
export function trapUnitLayers(locs: TrapLocations, colors: Record<string, string> = {}): TrapUnitLayers {
  const outlines: GeoJsonFC["features"] = [];
  const rings: GeoJsonFC["features"] = [];
  const labels: GeoJsonFC["features"] = [];
  for (const trap of Object.keys(locs).sort()) {
    const l = locs[trap];
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lng)) continue;
    const props = { trap, label: numberOf(trap, l.trap_number), unit: l.unit || "", c: colors[trap] || TRAP_IDLE };
    const g = l.unit_geometry;
    if (g && g.type !== "Point" && g.type !== "MultiPoint") {
      outlines.push({ type: "Feature", geometry: g, properties: props });
    } else {
      const at = g && g.type === "Point" ? (g.coordinates as [number, number]) : [l.lng, l.lat];
      rings.push({ type: "Feature", geometry: { type: "Point", coordinates: at }, properties: props });
    }
    labels.push({ type: "Feature", geometry: { type: "Point", coordinates: [l.lng, l.lat] }, properties: props });
  }
  const fc = (features: GeoJsonFC["features"]): GeoJsonFC => ({ type: "FeatureCollection", features });
  return { outlines: fc(outlines), rings: fc(rings), labels: fc(labels) };
}

/** Where the map put a trap, for its card: on its unit, a fixed point, a GPS estimate or the
 *  entries' average. */
export function trapPlacement(f: TrapLocations[string] | undefined): string {
  if (!f) return "Average of entries";
  if (f.unit && f.unit_geometry)
    return `On ${f.unit_type === "Triad" ? "hexagon" : f.unit_type === "Orchard Tree" ? "tree" : "bed"} ${f.unit}`;
  if (f.source === "Manual" || f.source === "Unit") return "Fixed · placed manually";
  return `GPS estimate · ${f.fixes} fixes`;
}
