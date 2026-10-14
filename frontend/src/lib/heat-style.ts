/**
 * Soft, level-based heat styling shared by every bed heatmap.
 *
 * A target keeps its legend colour, but the fill is eased towards the paper
 * colour and its opacity follows the level (count), so low levels are faint
 * and high levels deeper without ever turning neon.
 */

export const LEVEL_ALPHA = [0.18, 0.32, 0.5, 0.68] as const;
export const LEVEL_LABELS = ["Low", "Moderate", "High", "Severe"] as const;

export const PAPER_LIGHT = "#ffffff";
export const PAPER_DARK = "#1c1c19";
/** Share of the target colour kept when mixing towards paper. 1 = exact legend
 *  hue: level is carried by alpha alone. */
export const KEEP = 1;

/** Count -> level 1..4 (4 means 4 or more). Missing / non-positive counts are level 1. */
export function levelOf(count: number | null | undefined): number {
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(4, n);
}

/** Opacity for a level; levels beyond the ramp clamp to its ends. */
export function levelAlpha(level: number): number {
  const i = Math.min(LEVEL_ALPHA.length, Math.max(1, Math.round(level || 1))) - 1;
  return LEVEL_ALPHA[i];
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix a hex colour towards paper (keep = share of the colour kept). Non-hex input is returned unchanged. */
export function desaturate(hex: string, paper: string = PAPER_LIGHT, keep: number = KEEP): string {
  const c = parseHex(hex);
  const p = parseHex(paper);
  if (!c || !p) return hex;
  const mix = c.map((v, i) => Math.round(v * keep + p[i] * (1 - keep)));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Soft fill for a level: the exact target colour at the level's alpha. */
export function softFill(hex: string, level: number, paper: string = PAPER_LIGHT): string {
  const a = levelAlpha(level);
  const c = parseHex(desaturate(hex, paper));
  if (!c) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`;
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

export function isDarkTheme(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement;
  return el.classList.contains("dark") || el.getAttribute("data-theme") === "dark";
}

export function paperFor(dark: boolean = isDarkTheme()): string {
  return dark ? PAPER_DARK : PAPER_LIGHT;
}
