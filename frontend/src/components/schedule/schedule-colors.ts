/**
 * Chip and bar colours on the Schedule, by workflow state (spec C1).
 *
 * Each state is a light tint with a dark, same-hue foreground — and the reverse in
 * dark mode — so the text never sits on a saturated colour. Every pair clears WCAG
 * AA for chip text (≥ 4.5:1); `schedule-colors.test.ts` checks each one.
 *
 * Applied as CSS custom properties so one inline style serves both themes:
 * `chipProps(state)` gives the style and the classes that read it.
 */
import type { CSSProperties } from "react";

export type Theme = "light" | "dark";
export interface ChipColors {
  bg: string;
  fg: string;
  border: string;
}

type Tone = "amber" | "sky" | "indigo" | "violet" | "emerald" | "green" | "slate";

const PALETTE: Record<Tone, Record<Theme, ChipColors>> = {
  amber: {
    light: { bg: "#fef3c7", fg: "#78350f", border: "#fcd34d" },
    dark: { bg: "#451a03", fg: "#fde68a", border: "#92400e" },
  },
  sky: {
    light: { bg: "#e0f2fe", fg: "#0c4a6e", border: "#7dd3fc" },
    dark: { bg: "#082f49", fg: "#bae6fd", border: "#0369a1" },
  },
  indigo: {
    light: { bg: "#e0e7ff", fg: "#312e81", border: "#a5b4fc" },
    dark: { bg: "#1e1b4b", fg: "#c7d2fe", border: "#4338ca" },
  },
  violet: {
    light: { bg: "#ede9fe", fg: "#4c1d95", border: "#c4b5fd" },
    dark: { bg: "#2e1065", fg: "#ddd6fe", border: "#6d28d9" },
  },
  emerald: {
    light: { bg: "#d1fae5", fg: "#064e3b", border: "#6ee7b7" },
    dark: { bg: "#022c22", fg: "#a7f3d0", border: "#047857" },
  },
  green: {
    light: { bg: "#dcfce7", fg: "#14532d", border: "#86efac" },
    dark: { bg: "#052e16", fg: "#bbf7d0", border: "#15803d" },
  },
  slate: {
    light: { bg: "#f1f5f9", fg: "#1e293b", border: "#cbd5e1" },
    dark: { bg: "#0f172a", fg: "#e2e8f0", border: "#475569" },
  },
};

export function toneOf(state: string): Tone {
  switch (state) {
    case "Pending Submission":
    case "Awaiting Approval":
      return "amber";
    case "Approved":
      return "sky";
    case "Chemical Issued":
    case "Chemicals Issued Direct":
      return "indigo";
    case "Tank Mix Manufactured":
      return "violet";
    case "Spraying In Progress":
      return "emerald";
    case "Completed":
      return "green";
    default:
      return "slate";
  }
}

/** Every state the palette distinguishes (plus the fallback), for the tests. */
export const COLOURED_STATES = [
  "Pending Submission",
  "Awaiting Approval",
  "Approved",
  "Chemical Issued",
  "Chemicals Issued Direct",
  "Tank Mix Manufactured",
  "Spraying In Progress",
  "Completed",
  "Draft",
];

export function scheduleColors(state: string, theme: Theme = "light"): ChipColors {
  return PALETTE[toneOf(state)][theme];
}

/** Warning pill (crew unavailable): the same rule, in red. */
export const WARN_COLORS: Record<Theme, ChipColors> = {
  light: { bg: "#fee2e2", fg: "#7f1d1d", border: "#f87171" },
  dark: { bg: "#450a0a", fg: "#fecaca", border: "#b91c1c" },
};

/** Scout plan chips: Done / Missed / Planned. */
export const ASSIGNMENT_COLORS: Record<"Done" | "Missed" | "Planned" | "On leave", Record<Theme, ChipColors>> = {
  Done: PALETTE.green,
  Missed: {
    light: { bg: "#fee2e2", fg: "#7f1d1d", border: "#fca5a5" },
    dark: { bg: "#450a0a", fg: "#fecaca", border: "#b91c1c" },
  },
  Planned: PALETTE.slate,
  "On leave": PALETTE.amber,
};

/** Inline style + classes that paint a light/dark pair. Full border, never a strip. */
export function paint(c: Record<Theme, ChipColors>): { style: CSSProperties; className: string } {
  return {
    style: {
      "--sc-bg": c.light.bg,
      "--sc-fg": c.light.fg,
      "--sc-border": c.light.border,
      "--sc-bg-d": c.dark.bg,
      "--sc-fg-d": c.dark.fg,
      "--sc-border-d": c.dark.border,
    } as CSSProperties,
    className:
      "border bg-(--sc-bg) text-(--sc-fg) border-(--sc-border) dark:bg-(--sc-bg-d) dark:text-(--sc-fg-d) dark:border-(--sc-border-d)",
  };
}

/** A chip / bar painted for its workflow state, in both themes. */
export function chipProps(state: string) {
  return paint(PALETTE[toneOf(state)]);
}

// ── WCAG contrast ──────────────────────────────────────────────────────────

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
