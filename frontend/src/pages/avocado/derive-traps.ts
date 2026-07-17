import type { ProcessedData } from "@/lib/scouting-types";
import type { MarkerPoint } from "./tree-map-types";

// Catch-intensity ramp (matches the rose TrapsMap severity stops).
const SEVERITY_STOPS: Array<[number, string]> = [
  [5, "#fde68a"], [15, "#fcd34d"], [30, "#facc15"], [50, "#fb923c"],
  [75, "#f97316"], [100, "#dc2626"], [Infinity, "#7c2d12"],
];

export function severityColor(count: number): string {
  if (count <= 0) return "#e5e7eb";
  for (const [max, color] of SEVERITY_STOPS) if (count <= max) return color;
  return "#7c2d12";
}

function coord(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** One marker per trap at its averaged coordinate; count = summed catches,
 *  colour = severity of that total. Traps with no usable coordinate are dropped
 *  ((0,0) is the Atlantic → treated as missing). */
export function deriveTrapMarkers(data: ProcessedData | null): MarkerPoint[] {
  if (!data) return [];
  const agg = new Map<string, { latSum: number; lngSum: number; n: number; count: number }>();
  for (const e of data.entries) {
    const lat = coord(e.latitude);
    const lng = coord(e.longitude);
    const hasCoord =
      lat != null && lng != null && !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001);
    for (const t of e.trap_scouting_entry || []) {
      if (!t.trap) continue;
      let a = agg.get(t.trap);
      if (!a) {
        a = { latSum: 0, lngSum: 0, n: 0, count: 0 };
        agg.set(t.trap, a);
      }
      if (hasCoord) {
        a.count += t.count || 0;
        a.latSum += lat as number;
        a.lngSum += lng as number;
        a.n++;
      }
    }
  }
  const out: MarkerPoint[] = [];
  for (const [trap, a] of agg) {
    if (!a.n) continue; // no coordinate → can't place it
    out.push({
      lng: a.lngSum / a.n,
      lat: a.latSum / a.n,
      count: a.count,
      color: severityColor(a.count),
      label: trap,
    });
  }
  return out.sort((x, y) => y.count - x.count);
}
