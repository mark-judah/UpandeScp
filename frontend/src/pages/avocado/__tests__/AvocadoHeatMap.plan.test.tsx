/**
 * The avocado Application Floor Plan: the map on the left and the planning column on the right pick the
 * same blocks, the column plans each block and creates the drafts in one batch, and the heat keeps
 * kaitet's none/medium/high colouring. MapLibre is replaced by a recording fake; the planner's plan
 * panel by a stub.
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
  features: ["S1-B1 - KL", "S1-B2 - KL"].map((b, i) => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: ring(36 + i * 0.001) },
    properties: { block: b, block_label: b.split(" - ")[0], farm: "Lokitela", heat_style: "" },
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
  trap_scouting_entry: trap ? [{ trap: "Lokitela - T01", pest: "Thrips", count: trap }] : [],
});
const DATA = {
  entries: [entry(1, "S1-B1 - KL", 36.0004, 6), entry(2, "S1-B1 - KL", 36.0006, 0), entry(3, "S1-B2 - KL", 36.0015, 2), entry(4, "S1-B1 - KL", 36.0005, 0, 12)],
};
const TRAPS = {};

vi.mock("@/hooks/use-scouting", () => ({ useScouting: () => ({ data: DATA, loading: false, progress: 100, error: null }) }));
vi.mock("@/hooks/use-house-figures", () => ({ useHouseFigures: () => ({}) }));
vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#3366cc", disease: () => "#8b5cf6" }),
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchBlockAreas: vi.fn().mockResolvedValue({ "S1-B1 - KL": 2 }),
  fetchBlocksGeojson: vi.fn(() => Promise.resolve(BLOCKS)),
  fetchOrchardTreeRows: vi.fn().mockResolvedValue({ names: [], coords: [] }),
  fetchTrapLocations: vi.fn(() => Promise.resolve(TRAPS)),
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

const blk = (n: string) => ({ name: `${n} - KL`, label: n, farm: "Lokitela", crop: "Avocado", crop_label: "Avocado", area_ha: 2, cost_center: `${n} - KL` });

async function renderPage() {
  render(
    <ToastProvider>
      <AvocadoHeatMap initialCrop="Avocado" />
    </ToastProvider>,
  );
  await act(async () => {
    MAP.handlers.load?.forEach((f: Fn) => f());
  });
  await screen.findByRole("checkbox", { name: "S1-B1" });
}
const selData = () => (MAP.sources.get("block-sel")?.data?.features ?? []).map((f: any) => f.properties.block);

beforeEach(() => {
  MAP = fakeMap();
  document.body.innerHTML = "";
  fetchOpenFieldBlocks.mockReset().mockResolvedValue({
    groups: [{ kind: "Section", name: "Section 1 - KL", label: "Section 1", blocks: [blk("S1-B1"), blk("S1-B2")] }],
  });
  createDraftPlansBatch.mockReset().mockResolvedValue({
    results: [{ block: "S1-B1 - KL", work_order: "WO-1", warnings: [] }, { block: "S1-B2 - KL", work_order: "WO-2", warnings: [] }],
  });
});

describe("open-field Application Plan", () => {
  it("lays the map out on the left and the planning column on the right", async () => {
    await renderPage();
    const map = screen.getByTestId("plan-map");
    const col = screen.getByTestId("plan-column");
    expect(map.compareDocumentPosition(col) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(col).getByTestId("open-field-planner")).toBeInTheDocument();
    expect(fetchOpenFieldBlocks).toHaveBeenCalledWith("Avocado");
  });

  it("a block clicked on the map is ticked in the list and opens its card over the map", async () => {
    await renderPage();
    await act(async () => MAP.handlers["click:blocks-fill"][0]({ features: [{ properties: { block: "S1-B1 - KL" } }] }));
    expect(screen.getByRole("checkbox", { name: "S1-B1" })).toBeChecked();
    expect(selData()).toEqual(["S1-B1 - KL"]);
    const card = screen.getByRole("dialog", { name: "S1-B1 - KL" });
    expect(within(card).getByText("Thrips")).toBeInTheDocument();
    // the card can take it back out of the plan
    await userEvent.click(within(card).getByRole("button", { name: "Remove from the plan" }));
    expect(screen.getByRole("checkbox", { name: "S1-B1" })).not.toBeChecked();
  });

  it("a block ticked in the list is highlighted on the map and flown to", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("checkbox", { name: "S1-B2" }));
    expect(selData()).toEqual(["S1-B2 - KL"]);
    expect(MAP.fitBounds).toHaveBeenCalled();
  });

  it("plans each selected block and creates the drafts in one batch", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole("checkbox", { name: "Select all of Section 1" }));
    expect(selData()).toEqual(["S1-B1 - KL", "S1-B2 - KL"]);
    const create = await screen.findByRole("button", { name: /Create 2 draft plans/ });
    expect(create).toBeDisabled();
    await user.click(screen.getByText("complete S1-B1"));
    await user.click(screen.getByText("complete S1-B2"));
    await user.click(create);
    await waitFor(() => expect(createDraftPlansBatch).toHaveBeenCalledTimes(1));
    expect(createDraftPlansBatch.mock.calls[0][0].map((p: any) => p.custom_greenhouse)).toEqual(["S1-B1 - KL", "S1-B2 - KL"]);
    expect(await screen.findByText(/2 draft plans created/)).toBeInTheDocument();
    expect(selData()).toEqual([]);
  });

  it("keeps the none / medium / high colouring of the avocado heat", async () => {
    await renderPage();
    const legend = screen.getByTestId("heat-legend");
    expect(legend.innerHTML).toMatch(/rgb\(91, 180, 93\)/);
    expect(legend.innerHTML).toMatch(/rgb\(220, 38, 38\)/);
    expect(legend.textContent).toMatch(/Medium/);
  });

  it("with a disease in the window, all are selected: the legend names the worst observations and rows name their dominant one", async () => {
    const user = userEvent.setup();
    const extra = { ...entry(9, "S1-B2 - KL", 36.0016, 0), diseases_scouting_entry: [{ disease: "Anthracnose", severity_level: "3" }] };
    DATA.entries.push(extra as any);
    try {
      await renderPage();
      expect(screen.getByRole("button", { name: "Pests and diseases" })).toHaveTextContent("All pests and diseases");
      const legend = screen.getByTestId("heat-legend");
      expect(legend.textContent).toMatch(/Anthracnose/);
      expect(legend.textContent).toMatch(/Thrips/);
      expect(legend.textContent).toMatch(/worst selected observation/);
      expect(screen.getAllByTestId("row-heat").length).toBeGreaterThan(0);
      // the block with the disease is dominated by the disease, named beside its dot
      expect(within(screen.getByTestId("plan-column")).getAllByText("Anthracnose").length).toBeGreaterThan(0);
      // narrowing to one pest returns to the single-pest green/amber/red field
      await user.click(screen.getByRole("button", { name: "Pests and diseases" }));
      await user.click(screen.getByRole("option", { name: "Diseases, select all" }));
      expect(screen.getByRole("button", { name: "Pests and diseases" })).toHaveTextContent("Thrips");
      expect(screen.getByTestId("heat-legend").textContent).toMatch(/Medium/);
      expect(screen.queryByText(/worst selected observation/)).toBeNull();
    } finally {
      DATA.entries.pop();
    }
  });

  it("is titled Application Floor Plan", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { name: "Application Floor Plan" })).toBeInTheDocument();
  });
});
