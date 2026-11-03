/** Colour rules for the avocado Observations tree map.
 *
 *  Overview (no pick): every tree takes the colour of its DOMINANT observation
 *  (highest value among pests + diseases there), faded toward the unscouted
 *  tone by how that value ranks against the same observation's peak tree.
 *  Single pick: trees run green -> amber -> red for that one observation, the
 *  cut-offs being its own Count thresholds when set, else thirds of its peak. */
import type { ProcessedData } from "@/lib/scouting-types";
import type { ObsKind } from "@/lib/observation-colors";
import type { MeasuredBand } from "@/lib/threshold-measure";

export const SCALE_COLORS: [string, string, string] = ["#5bb45d", "#e9a23b", "#dc2626"];
export const SCALE_LABELS: [string, string, string] = ["Low", "Moderate", "High"];
export const UNSCOUTED_TONE = "#7c8b6a";
/** Weakest share of the pest colour a tree can show (so a minor hit stays visible). */
export const MIN_INTENSITY = 0.4;

export interface Obs {
  kind: ObsKind;
  name: string;
}
export const obsId = (o: Obs) => `${o.kind}|${o.name}`;

type Entry = ProcessedData["entries"][number];

function obsOf(e: Entry): Array<Obs & { count: number }> {
  const out: Array<Obs & { count: number }> = [];
  for (const p of e.pests_scouting_entry || [])
    if (p.pest) out.push({ kind: "pest", name: p.pest, count: p.count || 1 });
  for (const d of e.diseases_scouting_entry || [])
    if (d.disease) out.push({ kind: "disease", name: d.disease, count: 1 });
  return out;
}

/** tree -> observation id -> summed value. */
export function perTreeTotals(data: ProcessedData | null): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  if (!data) return m;
  for (const e of data.entries) {
    if (!e.tree) continue;
    for (const o of obsOf(e)) {
      let t = m.get(e.tree);
      if (!t) m.set(e.tree, (t = new Map()));
      const id = obsId(o);
      t.set(id, (t.get(id) || 0) + o.count);
    }
  }
  return m;
}

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.replace(/./g, "$&$&") : s;
  const n = parseInt(f, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** `hex` over `base` at opacity `a` (0..1). */
export function mix(hex: string, base: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [r2, g2, b2] = hexToRgb(base);
  const c = (x: number, y: number) =>
    Math.round(y + (x - y) * a).toString(16).padStart(2, "0");
  return `#${c(r, r2)}${c(g, g2)}${c(b, b2)}`;
}

export interface Dominant {
  id: string;
  value: number;
  intensity: number;
}

/** tree -> its dominant observation, value and intensity (MIN..1). Ties go to
 *  the pest seen on more trees, then the name, so the pick is stable. */
export function dominantPerTree(data: ProcessedData | null): Map<string, Dominant> {
  const totals = perTreeTotals(data);
  const peak = new Map<string, number>();
  const trees = new Map<string, number>();
  for (const t of totals.values())
    for (const [id, v] of t) {
      peak.set(id, Math.max(peak.get(id) || 0, v));
      trees.set(id, (trees.get(id) || 0) + 1);
    }
  const out = new Map<string, Dominant>();
  for (const [tree, t] of totals) {
    let best = "";
    let bestV = -1;
    for (const [id, v] of t) {
      if (
        v > bestV ||
        (v === bestV && ((trees.get(id) || 0) > (trees.get(best) || 0) || ((trees.get(id) || 0) === (trees.get(best) || 0) && id < best)))
      ) {
        best = id;
        bestV = v;
      }
    }
    const p = peak.get(best) || 1;
    out.set(tree, { id: best, value: bestV, intensity: MIN_INTENSITY + (1 - MIN_INTENSITY) * Math.min(1, bestV / p) });
  }
  return out;
}

/** Overview colours: dominant observation's colour, faded by intensity. */
export function deriveMultiColors(
  data: ProcessedData | null,
  colorOf: (o: Obs) => string,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [tree, d] of dominantPerTree(data)) {
    const [kind, ...rest] = d.id.split("|");
    m.set(tree, mix(colorOf({ kind: kind as ObsKind, name: rest.join("|") }), UNSCOUTED_TONE, d.intensity));
  }
  return m;
}

export interface Cuts {
  /** value >= moderate -> amber, >= high -> red */
  moderate: number;
  high: number;
  fromThreshold: boolean;
}

/** Cut-offs for one observation: its Count thresholds when set, else thirds of the peak. */
export function scaleCuts(peak: number, band?: MeasuredBand | null): Cuts {
  if (band && band.measure === "Count" && (band.moderate || 0) > 0 && (band.high || 0) > 0)
    return { moderate: band.moderate as number, high: band.high as number, fromThreshold: true };
  const p = Math.max(peak, 1);
  return { moderate: p / 3, high: (2 * p) / 3, fromThreshold: false };
}

export function levelFor(value: number, cuts: Cuts): 0 | 1 | 2 {
  return value >= cuts.high ? 2 : value >= cuts.moderate ? 1 : 0;
}

/** Peak per-tree value of one observation. */
export function peakOf(data: ProcessedData | null, o: Obs): number {
  let peak = 0;
  const id = obsId(o);
  for (const t of perTreeTotals(data).values()) peak = Math.max(peak, t.get(id) || 0);
  return peak;
}

/** Single-observation colours: visited trees run green/amber/red. */
export function deriveSingleColors(
  data: ProcessedData | null,
  o: Obs,
  band?: MeasuredBand | null,
): Map<string, string> {
  const m = new Map<string, string>();
  const totals = perTreeTotals(data);
  const id = obsId(o);
  let peak = 0;
  for (const t of totals.values()) peak = Math.max(peak, t.get(id) || 0);
  const cuts = scaleCuts(peak, band);
  // Every visited tree gets a colour: clean trees sit at the green end.
  for (const e of data?.entries || []) if (e.tree) m.set(e.tree, SCALE_COLORS[0]);
  for (const [tree, t] of totals) {
    const v = t.get(id);
    if (v) m.set(tree, SCALE_COLORS[levelFor(v, cuts)]);
  }
  return m;
}
