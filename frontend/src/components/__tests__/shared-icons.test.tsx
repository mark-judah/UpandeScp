/**
 * One icon set (9b): the domain shapes come from upande_scp/shared/icons via the
 * generated manifest, and rendering them must not change what the maps and the
 * weather tiles drew before.
 */
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SharedIcon, sharedIcon } from "@/components/SharedIcon";
import { MarkerDefs, MARKER_ID, iconKeyToShape, isLineShape } from "@/pages/maps/MarkerDefs";
import {
  DropletGlyph,
  GustGlyph,
  WeatherGlyph,
  type WeatherGlyphKind,
} from "@/components/WeatherGlyph";

const KINDS: WeatherGlyphKind[] = [
  "clear", "partly", "overcast", "fog", "drizzle", "rain", "showers", "snow", "thunder", "unknown",
];

describe("shared icon generator", () => {
  it("committed outputs are up to date (--check)", () => {
    const script = path.resolve(__dirname, "../../../../scripts/build_icons.mjs");
    expect(() => execFileSync("node", [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe("SharedIcon", () => {
  it("renders a manifest icon with its viewBox and body", () => {
    const { container } = render(<SharedIcon name="stage/star" size={20} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.querySelector("polygon")).not.toBeNull();
  });

  it("falls back to the circle for an unknown name", () => {
    expect(sharedIcon("stage/nope").key).toBe("circle");
    const { container } = render(<SharedIcon name="whatever" />);
    expect(container.querySelector("circle")).not.toBeNull();
  });

  it("caller fill/stroke override the icon's own", () => {
    const { container } = render(<SharedIcon name="stage/square" fill="#f00" stroke="#0f0" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("fill")).toBe("#f00");
    expect(svg.getAttribute("stroke")).toBe("#0f0");
  });
});

describe("MarkerDefs", () => {
  it("still emits all 10 symbol ids", () => {
    const { container } = render(<MarkerDefs />);
    const ids = [...container.querySelectorAll("symbol")].map((s) => s.id).sort();
    expect(ids).toEqual(Object.values(MARKER_ID).sort());
    expect(ids).toHaveLength(10);
    for (const s of container.querySelectorAll("symbol")) {
      expect(s.firstElementChild).not.toBeNull();
    }
  });

  it("line shapes are stroke-only, the rest fill from the caller", () => {
    const { container } = render(<MarkerDefs />);
    for (const [shape, id] of Object.entries(MARKER_ID)) {
      const el = container.querySelector(`#${id}`)!.firstElementChild!;
      const lineShape = isLineShape(shape as keyof typeof MARKER_ID);
      expect(el.getAttribute("fill")).toBe(lineShape ? "none" : null);
    }
  });

  it("keeps the icon_key → shape behaviour", () => {
    expect(iconKeyToShape("Star")).toBe("star");
    expect(iconKeyToShape("")).toBe("circle");
    expect(iconKeyToShape("bogus")).toBe("circle");
  });
});

describe("WeatherGlyph", () => {
  it("renders the same markup as before the move to shared icons", () => {
    const out: Record<string, string> = {};
    for (const k of KINDS) out[k] = renderToStaticMarkup(<WeatherGlyph kind={k} />);
    out.droplet = renderToStaticMarkup(<DropletGlyph />);
    out.gust = renderToStaticMarkup(<GustGlyph />);
    expect(Object.keys(out)).toEqual([...KINDS, "droplet", "gust"]);
    expect(out).toMatchSnapshot();
  });
});
