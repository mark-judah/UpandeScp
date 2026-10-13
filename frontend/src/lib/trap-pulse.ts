/**
 * Trap marker motion (spec 2026-10-11 TM1, TM2).
 *
 * A trap with catches pulses: a ring grows out of the marker and fades. The
 * marker's size and the ring's reach both grow with the count on a log scale
 * capped at PULSE_CAP, so one 5,000-catch trap does not swamp the map, and the
 * sizes do not depend on the other traps in view. A zero-count trap is a small
 * static dot. Only transform and opacity animate (compositor-only), and each
 * trap starts at its own point of the cycle so hundreds never beat in lockstep.
 */

/** The count at which a trap reaches full size and full pulse. */
export const PULSE_CAP = 200;
export const ZERO_SIZE = 8;
export const MIN_SIZE = 14;
export const MAX_SIZE = 40;

export interface TrapPulse {
  /** Marker diameter, px. */
  size: number;
  /** Peak scale of the pulse ring (1 = no growth). */
  scale: number;
  /** Seconds per beat. */
  duration: number;
  /** False for a zero-count trap: a static dot. */
  pulse: boolean;
  /** 0–1 — log-scaled, capped intensity. */
  level: number;
}

/** 0 → 1 on log10(1 + count), saturating at PULSE_CAP. */
export function pulseLevel(count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(1, Math.log10(1 + count) / Math.log10(1 + PULSE_CAP));
}

export function trapPulse(count: number): TrapPulse {
  const level = pulseLevel(count);
  if (level <= 0) return { size: ZERO_SIZE, scale: 1, duration: 0, pulse: false, level: 0 };
  return {
    size: Math.round(MIN_SIZE + (MAX_SIZE - MIN_SIZE) * level),
    scale: Math.round((1.25 + 1.15 * level) * 100) / 100,
    duration: Math.round((2.6 - 1.0 * level) * 100) / 100,
    pulse: true,
    level,
  };
}

/** A stable 0–1 offset per trap, so beats are staggered across the map. */
export function pulsePhase(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export const MIN_SIDES = 3;
export const MAX_SIDES = 20;

/** Polygon sides for a trap: twice its highest single catch, 3–20. */
export function polygonSides(maxCount: number): number {
  const n = Number.isFinite(maxCount) ? Math.round(maxCount * 2) : 0;
  return Math.max(MIN_SIDES, Math.min(MAX_SIDES, n));
}

/** SVG `points` for a regular polygon inscribed in a `size` square, first
 *  vertex at the top (so 4 sides is a diamond, 3 an upright triangle). */
export function polygonPoints(sides: number, size: number, inset = 1): string {
  const n = Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(sides)));
  const c = size / 2;
  const r = Math.max(0, c - inset);
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    pts.push(`${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** HTML for a trap marker (Leaflet divIcon, or a MapLibre Marker element):
 *  inline SVG polygon core with a pulse ring of the same shape under it.
 *  `maxCount` (highest single catch) sets the sides; a zero-catch trap stays a
 *  small circle. Colours are CSS colour strings. */
export function trapMarkerHtml(opts: {
  key: string;
  count: number;
  maxCount?: number;
  fill: string;
  stroke: string;
  reducedMotion: boolean;
}): string {
  const p = trapPulse(opts.count);
  const s = p.size;
  const shape = (extra: string) =>
    p.pulse
      ? `<polygon points="${polygonPoints(polygonSides(opts.maxCount ?? 0), s)}" ${extra}/>`
      : `<circle cx="${s / 2}" cy="${s / 2}" r="${s / 2 - 1}" ${extra}/>`;
  const paint = `fill="${opts.fill}" stroke="${opts.stroke}" stroke-width="1.5" stroke-linejoin="round"`;
  const svg = (cls: string, style: string, body: string) =>
    `<svg class="${cls}" style="${style}" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" aria-hidden="true">${body}</svg>`;
  const ring =
    p.pulse && !opts.reducedMotion
      ? svg(
          "scp-trap-ring",
          `--trap-pulse-scale:${p.scale};--trap-pulse-dur:${p.duration}s;animation-delay:-${(pulsePhase(opts.key) * p.duration).toFixed(2)}s`,
          shape(paint),
        )
      : "";
  return `<div class="scp-trap" style="width:${s}px;height:${s}px">${ring}${svg("scp-trap-core", "", shape(paint))}</div>`;
}

/** "#d9a514" + 0.45 → "rgba(217,165,20,0.45)"; anything else → fallback. */
export function withAlpha(hex: string | undefined, a: number, fallback: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || "").trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Fill and outline for a trap marker: the pest's colour, grey at zero. */
export function trapMarkerColors(pestHex: string | undefined, count: number): { fill: string; stroke: string } {
  if (!(count > 0)) return { fill: "rgba(10,10,10,0.20)", stroke: "rgba(10,10,10,0.28)" };
  return {
    fill: withAlpha(pestHex, 0.45, "rgba(217,165,20,0.35)"),
    stroke: withAlpha(pestHex, 0.9, "rgba(217,165,20,0.80)"),
  };
}

/** Selecting a trap zooms IN to it, never out: the current zoom, or ~19. */
export const TRAP_FOCUS_ZOOM = 19;
export function trapFocusZoom(current: number, max?: number): number {
  return Math.min(max || TRAP_FOCUS_ZOOM, Math.max(current, TRAP_FOCUS_ZOOM));
}

