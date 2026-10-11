import { describe, expect, it } from "vitest";
import { STATUS_PILL } from "../CrewPopover";
import {
  ASSIGNMENT_COLORS,
  COLOURED_STATES,
  WARN_COLORS,
  contrastRatio,
  scheduleColors,
  type Theme,
} from "../schedule-colors";
import { STATE_LEGEND } from "../schedule-utils";

const THEMES: Theme[] = ["light", "dark"];

describe("schedule colours (C1)", () => {
  it("every workflow state reaches WCAG AA chip text in both themes", () => {
    for (const state of [...new Set([...COLOURED_STATES, ...STATE_LEGEND, "Something new"])]) {
      for (const theme of THEMES) {
        const c = scheduleColors(state, theme);
        expect(contrastRatio(c.fg, c.bg), `${state} / ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("light mode is a light tint with dark text, dark mode the reverse", () => {
    for (const state of COLOURED_STATES) {
      const l = scheduleColors(state, "light");
      const d = scheduleColors(state, "dark");
      expect(contrastRatio(l.bg, "#ffffff")).toBeLessThan(1.3);
      expect(contrastRatio(d.bg, "#000000")).toBeLessThan(2);
    }
  });

  it("crew status pills, the warning and scout plan chips are AA too", () => {
    const pairs = [
      ...Object.values(STATUS_PILL),
      WARN_COLORS,
      ...Object.values(ASSIGNMENT_COLORS),
    ];
    for (const p of pairs) {
      for (const theme of THEMES) expect(contrastRatio(p[theme].fg, p[theme].bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("contrast ratio matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });
});
