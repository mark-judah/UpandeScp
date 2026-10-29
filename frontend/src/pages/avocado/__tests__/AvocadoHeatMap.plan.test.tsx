/**
 * The open-field Application Plan (spec 2026-10-29): the map on the left and the planning column on
 * the right pick the same blocks, the column plans each block and creates the drafts in one batch,
 * a trap click flies to the trap and opens its reading card, and the heat is drawn in the pest's
 * own colour. MapLibre is replaced by a recording fake; the planner's plan panel by a stub.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

// ------------------------------------------------------------------ a recording fake map
type Fn = (...a: any[]) => void;
function fakeMap() {
  const handlers: Record<string, Fn[]> = {};
  const sources = new Map<string, any>();
  const layers = new Set<string>();
  const map: any = {
    handlers,
    sources,
    layers,
    hits: [] as any[],
    on: (ev: string, a: any, b?: any) => {
      const key = typeof a === "string" ? `${ev}:${a}` : ev;
      (handlers[key] ||= []).push(typeof a === "function" ? a : b);
    },
    once: (_ev: string, fn: Fn) => fn(),
    off: () => {},
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: any) =>
      sources.set(id, { spec, data: spec.data, setData(d: any) { this.data = d; }, updateImage() {} }),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (l: any) => layers.add(l.id),
    removeLayer: (id: string) => layers.delete(id),
    setLayoutProperty: () => {},
    setPaintProperty: () => {},
    setFeatureState: () => {},
    removeFeatureState: () => {},
    fitBounds: vi.fn(),
    flyTo: vi.fn(),
    jumpTo: vi.fn(),
    easeTo: vi.fn(),
    getZoom: () => 15,
    getPitch: () => 0,
    getCanvas: () => ({ style: {} }),
    queryRenderedFeatures: () => map.hits,
  };
  return map;
}
let MAP: any;

vi.mock("maplibre-gl", () => {
  class Marker {
    el: HTMLElement;
    constructor({ element }: { element: HTMLElement }) {
      this.el = element;
    }
    setLngLat() {
      return this;
    }
    addTo() {
      document.body.appendChild(this.el);
      return this;
    }
    remove() {
      this.el.remove();
    }
    getElement() {
      return this.el;
    }
  }
  return { default: { Marker, MercatorCoordinate: { fromLngLat: () => ({ x: 0, y: 0, z: 0, meterInMercatorCoordinateUnits: () => 1 }) } } };
});
vi.mock("@/components/Map3D", () => ({
  Map3D: ({ onReady }: { onReady: (m: any) => void }) => {
    useEffect(() => onReady(MAP), [onReady]);
    return <div data-testid="map3d" />;
  },
}));
vi.mock("../../maps/MapHeader", async (orig) => ({
  ...(await orig<any>()),
  MapHeader: ({ title, rightSlot }: any) => (
    <header>
      <h1>{title}</h1>
      {rightSlot}
    </header>
  ),
}));

// ------------------------------------------------------------------ data
const ring = (x0: number) => [[[x0, 0], [x0 + 0.001, 0], [x0 + 0.001, 0.001], [x0, 0.001], [x0, 0]]];
const BLOCKS = {
  type: "FeatureCollection",
  features: ["P1-B1 - MUT", "P1-B2 - MUT"].map((b, i) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: ring(36 + i * 0.001) },
    properties: { block: b, block_label: b.split(" - ")[0], farm: "Mutara", heat_style: "" },
  })),
};
const entry = (n: number, block: string, lng: number, thrips: number, trap?: number) => ({
  name: `SE-${n}`,
  block,
  latitude: "0.0005",
  longitude: String(lng),
  date_of_capture: "2026-10-20",
  time_of_capture: "08:00:00",
  scouts_name: "E1",
  pests_scouting_entry: thrips ? [{ pest: "Thrips", count: thrips }] : [],
  diseases_scouting_entry: [],
  trap_scouting_entry: trap ? [{ trap: "Mutara - T01", pest: "Thrips", count: trap }] : [],
});
const DATA = {
  entries: [entry(1, "P1-B1 - MUT", 36.0004, 6), entry(2, "P1-B1 - MUT", 36.0006, 0), entry(3, "P1-B2 - MUT", 36.0015, 2), entry(4, "P1-B1 - MUT", 36.0005, 0, 12)],
};
const TRAPS = {
  "Mutara - T01": {
    lat: 0.0005, lng: 36.0005, source: "Unit", fixes: 0, spread_m: 0, flag: "", trap_number: "T01",
    unit_type: "Triad", unit: "P1-B1 - MUT - Row 1 - Triad 1",
    unit_geometry: { type: "Polygon", coordinates: [[[36.0004, 0.0004], [36.0006, 0.0004], [36.0006, 0.0006], [36.0004, 0.0004]]] },
  },
};

vi.mock("@/hooks/use-scouting", () => ({ useScouting: () => ({ data: DATA, loading: false, progress: 100, error: null }) }));
vi.mock("@/hooks/use-house-figures", () => ({ useHouseFigures: () => ({}) }));
vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#3366cc", disease: () => "#8b5cf6" }),
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchBlockAreas: vi.fn().mockResolvedValue({ "P1-B1 - MUT": 2 }),
  fetchBlocksGeojson: vi.fn(() => Promise.resolve(BLOCKS)),
  fetchOrchardTreeRows: vi.fn().mockResolvedValue({ names: [], coords: [] }),
  fetchTrapLocations: vi.fn(() => Promise.resolve(TRAPS)),
}));
vi.mock("@/lib/field-geo", async (orig) => ({
  ...(await orig<any>()),
  fetchFieldLayers: vi.fn().mockRejectedValue(new Error("offline")),
}));
vi.mock("@/lib/trap-reading-api", () => ({
  fetchLatestTrapReading: vi.fn().mockResolvedValue(null),
  fetchTrapPhotos: vi.fn().mockResolvedValue([]),
}));

const fetchOpenFieldBlocks = vi.fn();
const createDraftPlansBatch = vi.fn();
vi.mock("@/lib/open-field-api", () => ({
  fetchOpenFieldBlocks: (...a: unknown[]) => fetchOpenFieldBlocks(...a),
  fetchBlockFindings: vi.fn().mockResolvedValue({}),
  createDraftPlansBatch: (...a: unknown[]) => createDraftPlansBatch(...a),
}));
vi.mock("@/lib/spray-plan-creator-api", () => ({
  fetchCreatorBootstrap: vi.fn().mockResolvedValue({ spray_teams: [], kits: [], tank_mixes: [], farm_stores: {}, pest_catalog: [], disease_catalog: [], blocks: [] }),
}));
vi.mock("@/components/spray-plan/DraftBatchPanel", () => ({ DraftBatchPanel: () => <div data-testid="drafts" /> }));
vi.mock("@/components/spray-plan/BlockPlanPanel", () => ({
  BlockPlanPanel: (p: any) => (
    <div data-testid="plan-panel">
      {p.blocks.map((b: any) => (
        <button
          key={b.name}
          onClick={() =>
            p.onPlanChange(b.name, {
              classification: "Curative", reason: "", team: "T", kit: "", bom: "BOM-1", targets: ["Thrips"], area: "",
              chemicals: [{ item_code: "X", rate: 1, source: "S" }],
            })
          }
        >
          complete {b.label}
        </button>
      ))}
    </div>
  ),
}));

import { ToastProvider } from "@/components/Toast";
import { AvocadoHeatMap } from "@/pages/avocado/AvocadoHeatMap";

const blk = (n: string) => ({ name: `${n} - MUT`, label: n, farm: "Mutara", crop: "Potato", crop_label: "Potato", area_ha: 2, cost_center: `${n} - MUT` });

async function renderPage() {
  render(
    <ToastProvider>
      <AvocadoHeatMap initialCrop="Potato" />
    </ToastProvider>,
  );
  await act(async () => {
    MAP.handlers.load?.forEach((f: Fn) => f());
  });
  await screen.findByRole("checkbox", { name: "P1-B1" });
}
const selData = () => (MAP.sources.get("block-sel")?.data?.features ?? []).map((f: any) => f.properties.block);

beforeEach(() => {
  MAP = fakeMap();
  document.body.innerHTML = "";
  fetchOpenFieldBlocks.mockReset().mockResolvedValue({
    groups: [{ kind: "Pivot", name: "Pivot 1 - MUT", label: "Pivot 1", blocks: [blk("P1-B1"), blk("P1-B2")] }],
  });
  createDraftPlansBatch.mockReset().mockResolvedValue({
    results: [{ block: "P1-B1 - MUT", work_order: "WO-1", warnings: [] }, { block: "P1-B2 - MUT", work_order: "WO-2", warnings: [] }],
  });
});

describe("open-field Application Plan", () => {
  it("lays the map out on the left and the planning column on the right", async () => {
    await renderPage();
    const map = screen.getByTestId("plan-map");
    const col = screen.getByTestId("plan-column");
    expect(map.compareDocumentPosition(col) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(col).getByTestId("open-field-planner")).toBeInTheDocument();
    expect(fetchOpenFieldBlocks).toHaveBeenCalledWith("Potato");
  });

  it("a block clicked on the map is ticked in the list and opens its card over the map", async () => {
    await renderPage();
    MAP.hits = [{ layer: { id: "blocks-fill" }, properties: { block: "P1-B1 - MUT" } }];
    MAP.layers.add("blocks-fill");
    await act(async () => MAP.handlers.click[0]({ point: { x: 1, y: 1 } }));
    expect(screen.getByRole("checkbox", { name: "P1-B1" })).toBeChecked();
    expect(selData()).toEqual(["P1-B1 - MUT"]);
    const card = screen.getByRole("dialog", { name: "P1-B1 - MUT" });
    expect(within(card).getByText("Thrips")).toBeInTheDocument();
    // the card can take it back out of the plan
    await userEvent.click(within(card).getByRole("button", { name: "Remove from the plan" }));
    expect(screen.getByRole("checkbox", { name: "P1-B1" })).not.toBeChecked();
  });

  it("a block ticked in the list is highlighted on the map and flown to", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("checkbox", { name: "P1-B2" }));
    expect(selData()).toEqual(["P1-B2 - MUT"]);
    expect(MAP.fitBounds).toHaveBeenCalled();
  });

  it("plans each selected block and creates the drafts in one batch", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole("checkbox", { name: "Select all of Pivot 1" }));
    expect(selData()).toEqual(["P1-B1 - MUT", "P1-B2 - MUT"]);
    const create = await screen.findByRole("button", { name: /Create 2 draft plans/ });
    expect(create).toBeDisabled();
    await user.click(screen.getByText("complete P1-B1"));
    await user.click(screen.getByText("complete P1-B2"));
    await user.click(create);
    await waitFor(() => expect(createDraftPlansBatch).toHaveBeenCalledTimes(1));
    expect(createDraftPlansBatch.mock.calls[0][0].map((p: any) => p.custom_greenhouse)).toEqual(["P1-B1 - MUT", "P1-B2 - MUT"]);
    expect(await screen.findByText(/2 draft plans created/)).toBeInTheDocument();
    expect(selData()).toEqual([]);
  });

  it("draws each trap on its unit, numbered, and a trap click flies there and opens its reading card", async () => {
    await renderPage();
    const outlines = MAP.sources.get("trap-unit-outlines").data.features;
    expect(outlines.map((f: any) => [f.properties.trap, f.geometry.type, f.properties.c])).toEqual([["Mutara - T01", "Polygon", "#3366cc"]]);
    expect(MAP.sources.get("trap-unit-labels").data.features[0].properties.label).toBe("T01");
    const marker = document.querySelector<HTMLElement>('[data-trap="Mutara - T01"]');
    expect(marker).not.toBeNull();
    await act(async () => marker!.click());
    expect(MAP.flyTo).toHaveBeenCalledWith(expect.objectContaining({ center: [36.0005, 0.0005] }));
    const card = await screen.findByRole("dialog", { name: "Trap Mutara - T01" });
    expect(within(card).getByText(/On hexagon P1-B1 - MUT - Row 1 - Triad 1/)).toBeInTheDocument();
  });

  it("paints the heat in the pest's own colour, never green / amber / red", async () => {
    await renderPage();
    const legend = screen.getByTestId("heat-legend");
    const tones = Array.from(legend.querySelectorAll<HTMLElement>("[data-tone]")).map((el) => el.style.background);
    expect(tones).toHaveLength(3);
    for (const t of tones) expect(t.replace(/\s/g, "")).toMatch(/^rgba\(51,102,204,/);
    expect(legend.innerHTML).not.toMatch(/#5bb45d|#e9a23b|#dc2626|rgb\(91, 180, 93\)|rgb\(220, 38, 38\)/);
  });

  it("switches to 3D and back", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: "3D" }));
    expect(screen.getByRole("button", { name: "3D" })).toHaveAttribute("aria-pressed", "true");
    expect(MAP.easeTo).toHaveBeenCalledWith(expect.objectContaining({ pitch: 55 }));
    expect(MAP.layers.has("scouting-spheres")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "2D" }));
    expect(MAP.layers.has("scouting-spheres")).toBe(false);
  });
});
