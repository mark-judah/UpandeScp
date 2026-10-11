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

/** HTML for a Leaflet divIcon: the ring (when it pulses and motion is allowed)
 *  under the core disc. Colours are CSS colour strings. */
export function trapMarkerHtml(opts: {
  key: string;
  count: number;
  fill: string;
  stroke: string;
  reducedMotion: boolean;
}): string {
  const p = trapPulse(opts.count);
  const ring =
    p.pulse && !opts.reducedMotion
      ? `<span class="scp-trap-ring" style="--trap-pulse-scale:${p.scale};--trap-pulse-dur:${p.duration}s;animation-delay:-${(pulsePhase(opts.key) * p.duration).toFixed(2)}s;border-color:${opts.stroke};background:${opts.fill}"></span>`
      : "";
  return `<div class="scp-trap" style="width:${p.size}px;height:${p.size}px">${ring}<span class="scp-trap-core" style="background:${opts.fill};border-color:${opts.stroke}"></span></div>`;
}
