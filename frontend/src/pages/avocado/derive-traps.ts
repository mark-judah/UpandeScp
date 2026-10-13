import type { ProcessedData } from "@/lib/scouting-types";
import type { TrapLocations } from "@/lib/scouting-api";
import type { MarkerPoint } from "./tree-map-types";

function coord(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** One marker per trap; count = summed catches, colour = the colour of the
 *  pest caught most there (`pestColor`; severity is size + pulse only, so no
 *  colour ramp), `maxCount` = the highest single catch (polygon sides). A trap with a fixed location (`fixed`, from Trap.geojson) sits there
 *  and counts every catch. Otherwise it sits at the average of its entries'
 *  coordinates and counts only located catches; with no usable coordinate it
 *  is dropped ((0,0) is the Atlantic → treated as missing). */
export function deriveTrapMarkers(
  data: ProcessedData | null,
  fixed: TrapLocations = {},
  pestColor: (pest: string) => string = () => "#d9a514",
): MarkerPoint[] {
  if (!data) return [];
  type Latest = NonNullable<MarkerPoint["latest"]>;
  const agg = new Map<string, { latSum: number; lngSum: number; n: number; count: number; max: number; pests: Map<string, number>; latest?: Latest }>();
  for (const e of data.entries) {
    const lat = coord(e.latitude);
    const lng = coord(e.longitude);
    const hasCoord =
      lat != null && lng != null && !(Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001);
    for (const t of e.trap_scouting_entry || []) {
      if (!t.trap) continue;
      let a = agg.get(t.trap);
      if (!a) {
        a = { latSum: 0, lngSum: 0, n: 0, count: 0, max: 0, pests: new Map() };
        agg.set(t.trap, a);
      }
      const stamp = `${e.date_of_capture || ""} ${e.time_of_capture || ""}`;
      if (!a.latest || stamp > `${a.latest.date} ${a.latest.time}`) {
        a.latest = {
          date: e.date_of_capture || "",
          time: (e.time_of_capture || "").split(".")[0],
          scout: e.scouts_name || "",
          count: t.count || 0,
          pest: t.pest || "",
        };
      }
      const located = !!fixed[t.trap] || hasCoord;
      if (located) {
        const c = t.count || 0;
        a.count += c;
        if (c > a.max) a.max = c;
        if (t.pest) a.pests.set(t.pest, (a.pests.get(t.pest) || 0) + c);
      }
      if (!fixed[t.trap] && hasCoord) {
        a.latSum += lat as number;
        a.lngSum += lng as number;
        a.n++;
      }
    }
  }
  const out: MarkerPoint[] = [];
  for (const [trap, a] of agg) {
    const f = fixed[trap];
    if (!f && !a.n) continue; // no coordinate → can't place it
    let pest = "";
    let best = -1;
    for (const [name, n] of a.pests) if (n > best) { best = n; pest = name; }
    out.push({
      lng: f ? f.lng : a.lngSum / a.n,
      lat: f ? f.lat : a.latSum / a.n,
      count: a.count,
      color: a.count > 0 && pest ? pestColor(pest) : "#9ca3af",
      pest,
      maxCount: a.max,
      label: trap,
      latest: a.latest,
    });
  }
  return out.sort((x, y) => y.count - x.count);
}

/** Catches per pest across the markers (each trap counted under its main
 *  pest, as on the rose map), most first — the legend's figures. */
export function pestTotals(markers: MarkerPoint[]): Array<{ pest: string; count: number }> {
  const m = new Map<string, number>();
  for (const k of markers) if (k.pest) m.set(k.pest, (m.get(k.pest) || 0) + k.count);
  return [...m].map(([pest, count]) => ({ pest, count })).sort((a, b) => b.count - a.count || a.pest.localeCompare(b.pest));
}
