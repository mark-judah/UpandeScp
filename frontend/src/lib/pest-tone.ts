/**
 * Open-field heat in the pest's own colour (spec 2026-10-29 §3): the hue is the observation's
 * legend colour (useObservationColors) and the intensity is opacity, on the same level ramp the
 * rose bed heatmaps use (lib/heat-style). No green / amber / red band palette.
 *
 * Also the per-block heat style: a block paints as a Smear (the inverse-distance field across it)
 * or Solid (each hexagon filled). Warehouse.custom_heat_style sets it; blank = by kind, surveyed
 * hexagon blocks Solid, everything else (avocado trees, visit points) Smear.
 */
import { LEVEL_ALPHA } from "./heat-style";
import type { GeoJsonFC } from "./scouting-api";

/** Opacity per band: scouted-and-clean is a faint wash, then the roses levels 1, 3 and 4. */
export const TONE_ALPHA = { clean: 0.06, low: LEVEL_ALPHA[0], mid: LEVEL_ALPHA[2], high: LEVEL_ALPHA[3] } as const;
/** Colour for anything that cannot be read as a hex colour. */
const NEUTRAL: [number, number, number] = [90, 90, 84];

export function rgbOf(hex: string | null | undefined): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export type ToneBand = 0 | 1 | 2 | "clean";
const alphaOf = (band: ToneBand) =>
  band === "clean" ? TONE_ALPHA.clean : band === 0 ? TONE_ALPHA.low : band === 1 ? TONE_ALPHA.mid : TONE_ALPHA.high;

/** The pest colour at a band's opacity, as an rgba() string. */
export function toneOf(hex: string, band: ToneBand): string {
  const [r, g, b] = rgbOf(hex) ?? NEUTRAL;
  return `rgba(${r},${g},${b},${alphaOf(band)})`;
}

/** [low, medium, high, clean] tones of one colour: the shape triadObsColors takes. */
export function toneBands(hex: string): [string, string, string, string] {
  return [toneOf(hex, 0), toneOf(hex, 1), toneOf(hex, 2), toneOf(hex, "clean")];
}

/** Alphas per IDW class for renderRgba: low, medium, high and the scouted-clean floor. */
export const FIELD_ALPHAS = { low: TONE_ALPHA.low, mid: TONE_ALPHA.mid, high: TONE_ALPHA.high, clean: TONE_ALPHA.clean };

export type HeatStyle = "Smear" | "Solid";

/** A block's heat style: its explicit setting, else Solid for hexagon blocks and Smear for the rest. */
export function heatStyleOf(explicit: string | null | undefined, hasHexes: boolean): HeatStyle {
  if (explicit === "Smear" || explicit === "Solid") return explicit;
  return hasHexes ? "Solid" : "Smear";
}

/** Outlines whose blocks smear (they feed the IDW field) and the names of the blocks painted solid. */
export function splitByHeatStyle(blocks: GeoJsonFC, hexBlocks: Set<string>): { smear: GeoJsonFC; solid: Set<string> } {
  const smear: GeoJsonFC["features"] = [];
  const solid = new Set<string>();
  for (const f of blocks.features) {
    const p = (f.properties || {}) as { block?: string; heat_style?: string };
    const block = p.block || "";
    if (heatStyleOf(p.heat_style, hexBlocks.has(block)) === "Solid") solid.add(block);
    else smear.push(f);
  }
  return { smear: { ...blocks, features: smear }, solid };
}
