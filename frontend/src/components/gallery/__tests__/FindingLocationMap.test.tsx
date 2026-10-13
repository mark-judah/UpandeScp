import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBedsAndZones = vi.fn();
vi.mock("@/lib/scouting-api", () => ({ fetchBedsAndZones: (...a: unknown[]) => fetchBedsAndZones(...a) }));

const { FindingLocationMap, findingZones, clearHouseGeometryCache, loadHouseGeometry } = await import(
  "../FindingLocationMap"
);

const zone = (bed: number, z: number, y: number) => ({
  name: `GH1 - Bed ${bed} - Zone ${z}`,
  coords: [[36.0 + z * 0.0001, -1 + y], [36.0 + z * 0.0001 + 0.0001, -1 + y]],
  lineId: bed,
});
const tree = [
  { variety: "V", beds: [1, 2].map((b) => ({ name: `GH1 - Bed ${b}`, zones: [zone(b, 1, b * 0.0001), zone(b, 2, b * 0.0001)] })) },
];
const photo = { zone: "GH1 - Bed 2 - Zone 1", bed: "2", greenhouse: "GH1", house: "GH1", block: "", tree: "", subject: "Thrips", kind: "pest", entry: "E1" } as never;

beforeEach(() => {
  fetchBedsAndZones.mockReset();
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
});
