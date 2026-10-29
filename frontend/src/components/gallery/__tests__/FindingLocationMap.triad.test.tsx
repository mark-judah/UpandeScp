import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const sq = (x: number, y: number, s: number) => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
vi.mock("@/lib/scouting-api", () => ({
  fetchBedsAndZones: vi.fn(),
  fetchTrapLocations: vi.fn().mockResolvedValue({}),
  fetchOrchardTreeRows: vi.fn().mockResolvedValue({ names: [], coords: [] }),
  fetchBlocksGeojson: vi.fn().mockResolvedValue({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { block: "P1-B1 - MUT" }, geometry: { type: "Polygon", coordinates: sq(36.67, 0.04, 0.002) } }],
  }),
}));
// Two hexagons in the block; the second is the finding's.
vi.mock("@/lib/field-geo", async (orig) => ({
  ...(await orig<typeof import("@/lib/field-geo")>()),
  fetchFieldLayers: vi.fn().mockResolvedValue({
    version: "v", blocks: { type: "FeatureCollection", features: [] }, rows: [],
    hex: {
      q: 1e7,
      tpl: [[-100, -50], [0, -100], [100, -50], [100, 50], [0, 100], [-100, 50]],
      blocks: [{ b: "P1-B1 - MUT", reg: [1, 1, 366705000, 400100, 1, 2, 366715000, 400100], irr: [] }],
    },
  }),
}));

const { FindingLocationMap } = await import("../FindingLocationMap");

const base = { zone: "", bed: "", greenhouse: "", house: "", block: "P1-B1 - MUT", tree: "", subject: "Late Blight", kind: "disease", entry: "E1", trap: "" };

describe("FindingLocationMap · pivot block with hexagons", () => {
  it("draws the block's hexagons and pulses the finding's hexagon", async () => {
    render(<FindingLocationMap size="large" crop="Potato" photo={{ ...base, triad: "P1-B1 - MUT - Row 1 - Triad 2" } as never} />);
    expect(await screen.findByTestId("block-hexes")).toBeInTheDocument();
    const pulse = screen.getByTestId("finding-map-pulse");
    expect(pulse.style.left).not.toBe("");
    expect(screen.queryByTestId("finding-map-note")).toBeNull();
  });

  it("falls back to the logged coordinates when the hexagon is not mapped", async () => {
    render(<FindingLocationMap size="large" crop="Potato" photo={{ ...base, latitude: "0.041", longitude: "36.671" } as never} />);
    await screen.findByTestId("block-hexes");
    expect(screen.queryByTestId("finding-map-note")).toBeNull();
  });
});
