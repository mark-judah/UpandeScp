import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBomDetails = vi.fn();
vi.mock("@/lib/scouting-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/scouting-api")>()),
  fetchBomDetails: (...a: unknown[]) => fetchBomDetails(...a),
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

const blk = (n: string, crop = "Potato"): OpenFieldBlock => ({
  name: `${n} - MUT`, label: n, farm: "Mutara", crop, crop_label: crop, area_ha: 2, cost_center: `${n} - MUT`,
});

const BOOT: any = {
  spray_teams: [{ name: "Spray 1", custom_farm: "Mutara", members: [] }],
  kits: [],
  tank_mixes: [{ name: "BOM-1", item_name: "Mix 1" }],
  farm_stores: { Mutara: { chemical_store: "Chemical Store - MUT", fertilizer_store: null } },
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
      findings={{ "P1-B1 - MUT": { pests: [{ name: "Thrips", count: 4, last_seen: "2026-10-01" }], diseases: [], targets: ["Thrips"] } }}
      when="2026-10-30 06:00:00"
      {...over}
    />,
  );
  return { onPlanChange, user: userEvent.setup() };
}

beforeEach(() => fetchBomDetails.mockReset().mockResolvedValue(null));

describe("BlockPlanPanel", () => {
  it("has a section per selected block, the crop highlighted", () => {
    setup(["P1-B1", "P1-B2"]);
    expect(screen.getAllByTestId("block-section")).toHaveLength(2);
    const first = screen.getAllByTestId("block-section")[0];
    expect(within(first).getByTestId("crop-chip")).toHaveTextContent("Potato");
  });

  it("with two blocks every section is open", () => {
    setup(["P1-B1", "P1-B2"]);
    expect(screen.getAllByRole("button", { name: "Curative" })).toHaveLength(2);
  });

  it("with more than two blocks it collapses to one open block with a dropdown per block", async () => {
    const { user } = setup(["P1-B1", "P1-B2", "P1-B3"]);
    expect(screen.getAllByTestId("block-section")).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Curative" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /P1-B3/ }));
    expect(screen.getAllByRole("button", { name: "Curative" })).toHaveLength(1);
    expect(within(screen.getAllByTestId("block-section")[2]).getByRole("button", { name: "Curative" })).toBeInTheDocument();
  });

  it("the jump dropdown lists every selected block and opens the one picked", async () => {
    const { user } = setup(["P1-B1", "P1-B2", "P1-B3"]);
    await user.click(screen.getByRole("button", { name: "Jump to block" }));
    const list = screen.getByRole("listbox", { name: "Selected blocks" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    await user.click(within(list).getByRole("option", { name: /P1-B2/ }));
    expect(within(screen.getAllByTestId("block-section")[1]).getByRole("button", { name: "Curative" })).toBeInTheDocument();
  });

  it("shows the block's scouted findings and feeds them to the suggestions", () => {
    setup(["P1-B1"]);
    expect(screen.getAllByText(/Thrips/).length).toBeGreaterThan(0);
  });

  it("choosing Preventive or Curative updates that block's plan", async () => {
    const { user, onPlanChange } = setup(["P1-B1"]);
    await user.click(screen.getByRole("button", { name: "Preventive" }));
    expect(onPlanChange).toHaveBeenCalledWith("P1-B1 - MUT", expect.objectContaining({ classification: "Preventive" }));
  });

  it("picking a tank mix loads its chemicals into the plan with the farm's chemical store", async () => {
    fetchBomDetails.mockResolvedValue({
      name: "BOM-1", chemicals: [{ item_code: "X", item_name: "Xchem", stock_qty: 1.5, stock_uom: "Litre" }],
      chemical_warehouses: [], fertilizer_warehouses: [],
    });
    const { user, onPlanChange } = setup(["P1-B1"]);
    await user.click(screen.getByTestId("bom"));
    expect(onPlanChange).toHaveBeenCalledWith("P1-B1 - MUT", expect.objectContaining({ bom: "BOM-1" }));
    await vi.waitFor(() =>
      expect(onPlanChange).toHaveBeenCalledWith(
        "P1-B1 - MUT",
        expect.objectContaining({ chemicals: [expect.objectContaining({ item_code: "X", rate: 1.5, source: "Chemical Store - MUT" })] }),
      ),
    );
  });

  it("skeletons stand in while the planning data loads", () => {
    setup(["P1-B1"], { boot: null });
    expect(document.querySelector("[data-skeleton='plan']")).not.toBeNull();
  });
});
