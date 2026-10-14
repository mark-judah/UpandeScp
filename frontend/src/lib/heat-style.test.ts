import { describe, expect, it } from "vitest";
import { desaturate, levelAlpha, levelOf, softFill, PAPER_DARK } from "./heat-style";

describe("heat-style", () => {
  it("ramps alpha by level and clamps", () => {
    expect([1, 2, 3, 4].map(levelAlpha)).toEqual([0.18, 0.32, 0.5, 0.68]);
    expect(levelAlpha(9)).toBe(0.68);
    expect(levelAlpha(0)).toBe(0.18);
  });
  it("maps counts to levels", () => {
    expect(levelOf(undefined)).toBe(1);
    expect(levelOf(0)).toBe(1);
    expect(levelOf(3)).toBe(3);
    expect(levelOf(40)).toBe(4);
  });
  it("desaturates towards paper, keeping the hue order", () => {
    expect(desaturate("#000000", "#ffffff", 0.5)).toBe("#808080");
    const d = desaturate("#ff0000", "#ffffff", 0.8);
    expect(parseInt(d.slice(1, 3), 16)).toBe(255);
    expect(parseInt(d.slice(3, 5), 16)).toBeGreaterThan(0);
    expect(desaturate("#ff0000")).toBe("#ff0000");
  });
  it("softFill returns rgba at the level alpha, and tolerates non-hex", () => {
    expect(softFill("#2ba6e0", 2)).toBe("rgba(43,166,224,0.32)");
    expect(softFill("var(--x)", 3)).toContain("50%");
    expect(softFill("#ffffff", 1, PAPER_DARK)).toBe(softFill("#ffffff", 1));
  });
  it("is monotonic in alpha", () => {
    const a = [1, 2, 3, 4].map((l) => Number(/,([\d.]+)\)$/.exec(softFill("#e63946", l))![1]));
    expect([...a].sort((x, y) => x - y)).toEqual(a);
  });
});
