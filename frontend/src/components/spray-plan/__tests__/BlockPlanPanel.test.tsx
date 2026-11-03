import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBomDetails = vi.fn();
vi.mock("@/lib/scouting-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/scouting-api")>()),
  fetchBomDetails: (...a: unknown[]) => fetchBomDetails(...a),
}));
const fetchSprayProductRates = vi.fn();
vi.mock("@/lib/spray-rates", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-rates")>()),
  fetchSprayProductRates: (...a: unknown[]) => fetchSprayProductRates(...a),
}));
vi.mock("@/components/spray-plan/SuggestedProducts", () => ({
  SuggestedProductsCard: (p: { greenhouses: string[]; targets: string[] }) => (
    <div data-testid="suggestions">{`${p.greenhouses[0]}:${p.targets.join(",")}`}</div>
  ),
}));
vi.mock("@/components/BomPicker", () => ({
  BomPicker: (p: { value: string; onValueChange: (v: string) => void }) => (
    <button type="button" data-testid="bom" onClick={() => p.onValueChange("BOM-1")}>
      {p.value || "Select tank mix"}
    </button>
  ),
}));

import { BlockPlanPanel } from "@/components/spray-plan/BlockPlanPanel";
import { emptyPlan, type OpenFieldBlock } from "@/lib/open-field";

const blk = (n: string, crop = "Avocado"): OpenFieldBlock => ({
  name: `${n} - KL`, label: n, farm: "Lokitela", crop, crop_label: crop, area_ha: 2, cost_center: `${n} - KL`,
});

const BOOT: any = {
  spray_teams: [{ name: "Spray 1", custom_farm: "Lokitela", members: [] }],
  kits: [],
  tank_mixes: [{ name: "BOM-1", item_name: "Mix 1" }],
  farm_stores: { Lokitela: { chemical_store: "Chemical Store - KL", fertilizer_store: null } },
  pest_catalog: [{ name: "Thrips" }],
  disease_catalog: [],
};

function setup(names: string[], over: Record<string, unknown> = {}) {
  const blocks = names.map((n) => blk(n));
  const onPlanChange = vi.fn();
  const plans = Object.fromEntries(blocks.map((b) => [b.name, emptyPlan()]));
  render(
    <BlockPlanPanel
      blocks={blocks}
      plans={plans}
      onPlanChange={onPlanChange}
      boot={BOOT}
      findings={{ "S1-B1 - KL": { pests: [{ name: "Thrips", count: 4, last_seen: "2026-10-01" }], diseases: [], targets: ["Thrips"] } }}
      when="2026-10-30 06:00:00"
      {...over}
    />,
  );
  return { onPlanChange, user: userEvent.setup() };
}

beforeEach(() => {
  fetchBomDetails.mockReset().mockResolvedValue(null);
  fetchSprayProductRates.mockReset().mockResolvedValue({});
});

describe("BlockPlanPanel", () => {
  it("has a section per selected block, the crop highlighted", () => {
    setup(["S1-B1", "S1-B2"]);
    expect(screen.getAllByTestId("block-section")).toHaveLength(2);
    const first = screen.getAllByTestId("block-section")[0];
    expect(within(first).getByTestId("crop-chip")).toHaveTextContent("Avocado");
  });

  it("with two blocks every section is open", () => {
    setup(["S1-B1", "S1-B2"]);
    expect(screen.getAllByRole("button", { name: "Curative" })).toHaveLength(2);
  });

  it("with more than two blocks it collapses to one open block with a dropdown per block", async () => {
    const { user } = setup(["S1-B1", "S1-B2", "S1-B3"]);
    expect(screen.getAllByTestId("block-section")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Curative" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /S1-B3/ }));
    expect(screen.getAllByRole("button", { name: "Curative" })).toHaveLength(1);
    expect(within(screen.getAllByTestId("block-section")[2]).getByRole("button", { name: "Curative" })).toBeInTheDocument();
  });

  it("the jump dropdown lists every selected block and opens the one picked", async () => {
    const { user } = setup(["S1-B1", "S1-B2", "S1-B3"]);
    await user.click(screen.getByRole("button", { name: "Jump to block" }));
    const list = screen.getByRole("listbox", { name: "Selected blocks" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    await user.click(within(list).getByRole("option", { name: /S1-B2/ }));
    expect(within(screen.getAllByTestId("block-section")[1]).getByRole("button", { name: "Curative" })).toBeInTheDocument();
  });

  it("shows the block's scouted findings and feeds them to the suggestions", () => {
    setup(["S1-B1"]);
    expect(screen.getAllByText(/Thrips/).length).toBeGreaterThan(0);
  });

  it("choosing Preventive or Curative updates that block's plan", async () => {
    const { user, onPlanChange } = setup(["S1-B1"]);
    await user.click(screen.getByRole("button", { name: "Preventive" }));
    expect(onPlanChange).toHaveBeenCalledWith("S1-B1 - KL", expect.objectContaining({ classification: "Preventive" }));
  });

  it("picking a tank mix loads its chemicals into the plan with the farm's chemical store", async () => {
    fetchBomDetails.mockResolvedValue({
      name: "BOM-1", chemicals: [{ item_code: "X", item_name: "Xchem", stock_qty: 1.5, stock_uom: "Litre" }],
      chemical_warehouses: [], fertilizer_warehouses: [],
    });
    const { user, onPlanChange } = setup(["S1-B1"]);
    await user.click(screen.getByTestId("bom"));
    expect(onPlanChange).toHaveBeenCalledWith("S1-B1 - KL", expect.objectContaining({ bom: "BOM-1" }));
    await vi.waitFor(() =>
      expect(onPlanChange).toHaveBeenCalledWith(
        "S1-B1 - KL",
        expect.objectContaining({ chemicals: [expect.objectContaining({ item_code: "X", rate: 1.5, source: "Chemical Store - KL" })] }),
      ),
    );
  });

  it("skeletons stand in while the planning data loads", () => {
    setup(["S1-B1"], { boot: null });
    expect(document.querySelector("[data-skeleton='plan']")).not.toBeNull();
  });

  it("lists each block's own crop targets, not the route crop's, in a mixed selection", async () => {
    const avo = { ...blk("Avocado Block A", "Avocado") };
    const pot = { ...blk("S1-B1", "Coffee") };
    const blocks = [avo, pot];
    const bootFor = (pests: string[]) => ({ ...BOOT, pest_catalog: pests.map((name) => ({ name })) });
    render(
      <BlockPlanPanel
        blocks={blocks}
        plans={Object.fromEntries(blocks.map((b) => [b.name, { ...emptyPlan(), classification: "Preventive" as const }]))}
        onPlanChange={vi.fn()}
        boot={bootFor(["Avocado Thrips"])}
        bootByCrop={{ Avocado: bootFor(["Avocado Thrips"]), Coffee: bootFor(["Late blight"]) }}
        findings={{}}
        when="2026-10-30 06:00:00"
      />,
    );
    const [a, p] = screen.getAllByTestId("block-section");
    expect(within(a).getByRole("button", { name: "Avocado Thrips" })).toBeInTheDocument();
    expect(within(a).queryByRole("button", { name: "Late blight" })).toBeNull();
    expect(within(p).getByRole("button", { name: "Late blight" })).toBeInTheDocument();
    expect(within(p).queryByRole("button", { name: "Avocado Thrips" })).toBeNull();
  });

  it("a product with a Hectarage rate for the block's crop is planned on it and shows its basis", async () => {
    fetchBomDetails.mockResolvedValue({
      name: "BOM-1", chemicals: [{ item_code: "X", item_name: "Xchem", stock_qty: 1.5, stock_uom: "Litre" }],
      chemical_warehouses: [], fertilizer_warehouses: [],
    });
    fetchSprayProductRates.mockResolvedValue({
      X: [{ basis: "Hectarage", lower: 2, upper: 4, crop: "Avocado", source: "crop" }],
    });
    const { user, onPlanChange } = setup(["S1-B1"]);
    await user.click(screen.getByTestId("bom"));
    await vi.waitFor(() =>
      expect(onPlanChange).toHaveBeenCalledWith(
        "S1-B1 - KL",
        expect.objectContaining({ chemicals: [expect.objectContaining({ basis: "Hectarage", rate: 3 })] }),
      ),
    );
    expect(fetchSprayProductRates).toHaveBeenCalledWith(["X"], "Avocado");
  });

  it("shows the basis and the quantity from the block's area", () => {
    const b = blk("S1-B1");
    render(
      <BlockPlanPanel
        blocks={[b]}
        plans={{ [b.name]: { ...emptyPlan(), classification: "Curative", bom: "BOM-1", chemicals: [{ item_code: "X", item_name: "Xchem", stock_uom: "Litre", basis: "Hectarage", rate: 3 }] } }}
        onPlanChange={vi.fn()}
        boot={BOOT}
        findings={{}}
        when="2026-10-30 06:00:00"
      />,
    );
    expect(screen.getByTestId("rate-basis")).toHaveTextContent("Hectarage");
    // 2 ha x 3 per hectare
    expect(screen.getByText(/6\.00 Litre/)).toBeInTheDocument();
  });
});
