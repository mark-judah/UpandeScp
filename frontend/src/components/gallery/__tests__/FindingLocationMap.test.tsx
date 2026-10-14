import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBedsAndZones = vi.fn();
const fetchTrapLocations = vi.fn();
vi.mock("@/lib/scouting-api", () => ({
  fetchBedsAndZones: (...a: unknown[]) => fetchBedsAndZones(...a),
  fetchTrapLocations: (...a: unknown[]) => fetchTrapLocations(...a),
}));

const { FindingLocationMap, findingZones, clearHouseGeometryCache, loadHouseGeometry, heatmapsHref, trapSpot } = await import(
  "../FindingLocationMap"
);

const zone = (bed: number, z: number, y: number) => ({
  name: `GH1 - Bed ${bed} - Zone ${z}`,
  raw_geojson: JSON.stringify({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[36.0 + z * 0.0001, -1 + y], [36.0 + z * 0.0001 + 0.0001, -1 + y]] },
      properties: { line_id: bed },
    }],
  }),
});
const tree = [
  { variety: "V", beds: [1, 2].map((b) => ({ name: `GH1 - Bed ${b}`, zones: [zone(b, 1, b * 0.0001), zone(b, 2, b * 0.0001)] })) },
];
const photo = { zone: "GH1 - Bed 2 - Zone 1", bed: "2", greenhouse: "GH1", house: "GH1", block: "", tree: "", subject: "Thrips", kind: "pest", entry: "E1" } as never;

beforeEach(() => {
  fetchBedsAndZones.mockReset();
  fetchTrapLocations.mockReset();
  clearHouseGeometryCache();
});

describe("FindingLocationMap", () => {
  it("shows a skeleton, then the map with a pulse and a heatmaps link", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    const { container } = render(<FindingLocationMap photo={photo} crop="Rose" />);
    expect(screen.getByTestId("finding-map-skeleton")).toBeInTheDocument();
    const map = await screen.findByTestId("finding-map");
    expect(map.getAttribute("href")).toContain("#/rose/heatmaps?gh=GH1&obs=Thrips&kind=pest");
    expect(screen.getByTestId("finding-map-pulse")).toBeInTheDocument();
    expect(map.querySelector("svg")).not.toBeNull();
  });
  it("large size fills its parent with a pulse and no link", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    render(<FindingLocationMap photo={photo} crop="Rose" size="large" />);
    const map = await screen.findByTestId("finding-map");
    expect(map.getAttribute("data-size")).toBe("large");
    expect(map.tagName).toBe("DIV");
    expect(screen.getByTestId("finding-map-pulse")).toBeInTheDocument();
    expect(map.querySelectorAll("[data-testid='bed-line']").length).toBeGreaterThan(0);
  });
  it("large size says there is no bed map, with the place", async () => {
    fetchBedsAndZones.mockResolvedValue([]);
    render(<FindingLocationMap size="large" photo={{ ...(photo as object), greenhouse: "Lokitela", block: "B3", tree: "12", zone: "", bed: "" } as never} />);
    expect(await screen.findByText("No bed map for this block yet")).toBeInTheDocument();
    expect(screen.getByText(/Lokitela · Block B3 · Tree 12/)).toBeInTheDocument();
  });
  it("builds the heatmaps link", () => {
    expect(heatmapsHref(photo, "Avocado")).toBe("#/avocado/heatmaps?gh=GH1&obs=Thrips&kind=pest");
  });
  it("fetches the geometry once per house", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    await loadHouseGeometry("GH1");
    await loadHouseGeometry("GH1");
    expect(fetchBedsAndZones).toHaveBeenCalledTimes(1);
  });
  it("renders nothing when the house has no bed geometry", async () => {
    fetchBedsAndZones.mockResolvedValue([]);
    const { container } = render(<FindingLocationMap photo={{ ...(photo as object), greenhouse: "Lokitela", block: "B3", tree: "12", zone: "", bed: "" } as never} />);
    await waitFor(() => expect(screen.queryByTestId("finding-map-skeleton")).toBeNull());
    expect(container).toBeEmptyDOMElement();
  });
  it("marks the named zone, or every zone of the bed", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    const g = (await loadHouseGeometry("GH1"))!;
    expect(findingZones(g, { zone: "GH1 - Bed 2 - Zone 1", bed: "2" } as never)).toEqual(["GH1 - Bed 2 - Zone 1"]);
    expect(findingZones(g, { zone: "", bed: "1" } as never).sort()).toEqual(["GH1 - Bed 1 - Zone 1", "GH1 - Bed 1 - Zone 2"]);
  });

  const trapPhoto = { ...(photo as object), trap: "GH1 - 1513", bed: "", zone: "", subject: "Duponchella" } as never;
  const fixed = { lat: -1 + 0.0002, lng: 36.00015, source: "GPS estimate", fixes: 5, spread_m: 1, flag: "" };

  it("trap finding with no bed or zone: draws the house and marks the trap's fixed position", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    fetchTrapLocations.mockResolvedValue({ "GH1 - 1513": fixed });
    render(<FindingLocationMap photo={trapPhoto} crop="Rose" size="large" />);
    const map = await screen.findByTestId("finding-map");
    expect(map.querySelectorAll("[data-testid='bed-line']").length).toBeGreaterThan(0);
    expect(screen.getByTestId("finding-map-pulse")).toBeInTheDocument();
    expect(screen.getByTestId("finding-map-trap-label")).toHaveTextContent("Trap GH1 - 1513");
    expect(screen.queryByText("No bed map for this block yet")).toBeNull();
    expect(screen.queryByTestId("finding-map-note")).toBeNull();
  });
  it("trap with no position: still draws the house, says the position is not mapped", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    fetchTrapLocations.mockResolvedValue({});
    render(<FindingLocationMap photo={trapPhoto} size="large" />);
    const map = await screen.findByTestId("finding-map");
    expect(map.querySelectorAll("[data-testid='bed-line']").length).toBeGreaterThan(0);
    expect(screen.getByTestId("finding-map-note")).toHaveTextContent("Trap position not mapped");
    expect(screen.queryByTestId("finding-map-pulse")).toBeNull();
    expect(screen.queryByText("No bed map for this block yet")).toBeNull();
  });
  it("non-trap finding highlights its bed and zone, with a pulse", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    render(<FindingLocationMap photo={photo} size="large" />);
    const map = await screen.findByTestId("finding-map");
    expect(screen.getByTestId("finding-map-pulse")).toBeInTheDocument();
    expect(screen.queryByTestId("finding-map-note")).toBeNull();
    expect(fetchTrapLocations).not.toHaveBeenCalled();
    expect(map.querySelector("svg")).not.toBeNull();
  });
  it("no bed or zone and not a trap: whole house with a note", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    render(<FindingLocationMap photo={{ ...(photo as object), bed: "", zone: "" } as never} size="large" />);
    await screen.findByTestId("finding-map");
    expect(screen.getByTestId("finding-map-note")).toHaveTextContent("Bed not recorded");
  });
  it("trapSpot projects a fixed location into the drawing", async () => {
    fetchBedsAndZones.mockResolvedValue(tree);
    const g = (await loadHouseGeometry("GH1"))!;
    const s = trapSpot(g, fixed)!;
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.x).toBeLessThanOrEqual(100);
    expect(trapSpot(g, null)).toBeNull();
    expect(trapSpot(g, { lat: 10, lng: 50 })!.outside).toBe(true);
  });
});
