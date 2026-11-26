import { useState } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchBomDetails = vi.fn();
const getItemAvailability = vi.fn();
vi.mock("@/lib/scouting-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/scouting-api")>()),
  fetchBomDetails: (...a: unknown[]) => fetchBomDetails(...a),
  getItemAvailability: (...a: unknown[]) => getItemAvailability(...a),
  fetchChemicalBalances: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/spray-rates", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-rates")>()),
  fetchSprayProductRates: vi.fn().mockResolvedValue({}),
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
import { emptyPlan, type BlockPlan, type OpenFieldBlock } from "@/lib/open-field";

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

beforeEach(() => {
  fetchBomDetails.mockReset().mockResolvedValue(null);
  getItemAvailability.mockReset().mockResolvedValue({});
});

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

  it("lists each block's own crop targets, not the route crop's, in a mixed selection", async () => {
    const avo = { ...blk("Avocado Block A", "Avocado") };
    const pot = { ...blk("P1-B1", "Potato") };
    const blocks = [avo, pot];
    const bootFor = (pests: string[]) => ({ ...BOOT, pest_catalog: pests.map((name) => ({ name })) });
    render(
      <BlockPlanPanel
        blocks={blocks}
        plans={Object.fromEntries(blocks.map((b) => [b.name, { ...emptyPlan(), classification: "Preventive" as const }]))}
        onPlanChange={vi.fn()}
        boot={bootFor(["Avocado Thrips"])}
        bootByCrop={{ Avocado: bootFor(["Avocado Thrips"]), Potato: bootFor(["Late blight"]) }}
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
});

const STORE = "Chemical Store - MUT";
const avail = (over: Record<string, unknown> = {}) => ({
  ledger: 10, reserved: 0, reserved_submitted: 0, reserved_by: [], has_batch_no: 0, batches: [], ...over,
});
const chem = (code: string, over: Record<string, unknown> = {}) => ({
  item_code: code, item_name: `${code}chem`, stock_uom: "Litre", basis: "Water" as const, rate: 1,
  source: STORE, balances: { [STORE]: 10 }, rowId: `${code}-0`, ...over,
});
const planned = (chemicals: ReturnType<typeof chem>[], over: Partial<BlockPlan> = {}): BlockPlan => ({
  ...emptyPlan(), classification: "Curative", team: "Spray 1", targets: ["Thrips"], bom: "BOM-1", water: "1000", chemicals, ...over,
});

/** The planner keeps every block's plan; this holds them like OpenFieldPlanner does. */
function Live({ blocks, initial, onPlans }: { blocks: OpenFieldBlock[]; initial: Record<string, BlockPlan>; onPlans?: (p: Record<string, BlockPlan>) => void }) {
  const [plans, setPlans] = useState(initial);
  onPlans?.(plans);
  return (
    <BlockPlanPanel
      blocks={blocks}
      plans={plans}
      onPlanChange={(n, p) => setPlans((m) => ({ ...m, [n]: p }))}
      boot={BOOT}
      findings={{}}
      when="2026-10-30 06:00:00"
    />
  );
}

describe("BlockPlanPanel — the shared plan form per block", () => {
  it("gives each selected block its own form: tank mix with New tank mix, Add chemical, MOA and Scheduled Application", () => {
    const blocks = [blk("P1-B1"), blk("P1-B2")];
    render(<Live blocks={blocks} initial={Object.fromEntries(blocks.map((b) => [b.name, emptyPlan()]))} />);
    const [a, b] = screen.getAllByTestId("block-section");
    for (const s of [a, b]) {
      expect(within(s).getByRole("button", { name: /New tank mix/ })).toBeInTheDocument();
      expect(within(s).getByRole("button", { name: "Add chemical" })).toBeInTheDocument();
      expect(within(s).getByTitle("Method of application")).toHaveTextContent("MOA");
      expect(within(s).getByTestId("team-kit-moa")).toBeInTheDocument();
      expect(within(s).getByTestId("scheduled-application")).toBeInTheDocument();
    }
  });

  it("a tank mix picked on one block stays on that block", async () => {
    fetchBomDetails.mockResolvedValue({
      name: "BOM-1", chemicals: [{ item_code: "X", item_name: "Xchem", stock_qty: 1.5, stock_uom: "Litre" }],
      chemical_warehouses: [], fertilizer_warehouses: [],
    });
    const blocks = [blk("P1-B1"), blk("P1-B2")];
    let latest: Record<string, BlockPlan> = {};
    const user = userEvent.setup();
    render(<Live blocks={blocks} initial={Object.fromEntries(blocks.map((b) => [b.name, emptyPlan()]))} onPlans={(p) => (latest = p)} />);
    await user.click(within(screen.getAllByTestId("block-section")[0]).getByTestId("bom"));
    await waitFor(() => expect(latest["P1-B1 - MUT"].chemicals.map((c) => c.item_code)).toEqual(["X"]));
    expect(latest["P1-B2 - MUT"].bom).toBe("");
    expect(latest["P1-B2 - MUT"].chemicals).toEqual([]);
  });

  it("Available on one block nets off what the other selected block draws from the same store", async () => {
    getItemAvailability.mockResolvedValue({ X: avail() });
    const blocks = [blk("P1-B1"), blk("P1-B2")];
    const user = userEvent.setup();
    render(
      <Live
        blocks={blocks}
        initial={{ "P1-B1 - MUT": planned([chem("X", { rate: 4 })]), "P1-B2 - MUT": planned([chem("X")]) }}
      />,
    );
    const [a, b] = screen.getAllByTestId("block-section");
    // 10 on hand; the other block draws 4 (rate 4 per 1000 L x 1000 L) / 1
    await waitFor(() => expect(within(b).getByTestId("available-X")).toHaveTextContent(/^6/));
    expect(within(a).getByTestId("available-X")).toHaveTextContent(/^9/);
    const rate = within(a).getByLabelText("Rate of Xchem");
    await user.clear(rate);
    await user.type(rate, "2");
    await waitFor(() => expect(within(b).getByTestId("available-X")).toHaveTextContent(/^8/));
  });

  it("a batch-tracked item with no batch blocks only its own block, with the roses message", async () => {
    getItemAvailability.mockImplementation(async (_s: string, codes: string[]) =>
      Object.fromEntries(
        codes.map((c) => [
          c,
          c === "X"
            ? avail({
                has_batch_no: 1, batch_required: true,
                batches: [{ batch_no: "B-1", qty: 0.5, expiry_date: null, reserved: 0, available: 0.5, placeholder: false, expired: false }],
              })
            : avail(),
        ]),
      ),
    );
    const blocks = [blk("P1-B1"), blk("P1-B2")];
    render(<Live blocks={blocks} initial={{ "P1-B1 - MUT": planned([chem("X")]), "P1-B2 - MUT": planned([chem("Z")]) }} />);
    const [a, b] = screen.getAllByTestId("block-section");
    expect(await within(a).findByText("Pick a batch for Xchem.")).toBeInTheDocument();
    expect(within(a).getByText("Needs a batch for Xchem")).toBeInTheDocument();
    expect(within(a).getByRole("columnheader", { name: "Batch" })).toBeInTheDocument();
    expect(within(b).queryByText(/Pick a batch/)).toBeNull();
    expect(within(b).queryByRole("columnheader", { name: "Batch" })).toBeNull();
    expect(within(b).getByText("Ready")).toBeInTheDocument();
  });

  it("a block with no area asks for it on Area rows and never shows NaN", async () => {
    const noArea = { ...blk("P1-B1"), area_ha: 0 };
    render(<Live blocks={[noArea]} initial={{ [noArea.name]: planned([chem("X", { basis: "Hectarage" })]) }} />);
    const s = screen.getByTestId("block-section");
    expect(within(s).getByTestId("qty-X")).toHaveTextContent("enter the block area");
    expect(s.textContent).not.toMatch(/NaN/);
  });
});

describe("BlockPlanPanel — stock gate", () => {
  it("a short block shows the roses message and blocks only itself; lowering the quantity unblocks it", async () => {
    getItemAvailability.mockResolvedValue({ X: avail(), Z: avail() });
    const blocks = [blk("P1-B1"), blk("P1-B2")];
    const user = userEvent.setup();
    render(<Live blocks={blocks} initial={{ "P1-B1 - MUT": planned([chem("X", { rate: 12 })]), "P1-B2 - MUT": planned([chem("Z")]) }} />);
    const [a, b] = screen.getAllByTestId("block-section");
    expect(await within(a).findByTestId("stock-short")).toHaveTextContent("1 chemical is short on stock");
    expect(within(a).getByTestId("stock-short")).toHaveTextContent(`Xchem: ${STORE} has 10.00 available but needs 12.00.`);
    await waitFor(() => expect(within(a).getByText("Needs stock for Xchem")).toBeInTheDocument());
    expect(within(b).queryByTestId("stock-short")).toBeNull();
    expect(within(b).getByText("Ready")).toBeInTheDocument();
    const rate = within(a).getByLabelText("Rate of Xchem");
    await user.clear(rate);
    await user.type(rate, "5");
    await waitFor(() => expect(within(a).queryByTestId("stock-short")).toBeNull());
    expect(within(a).getByText("Ready")).toBeInTheDocument();
  });
});

describe("BlockPlanPanel — jump, remove, required fields", () => {
  it("Jump to block brings the block forward, rings it and tells the page (to move the map)", async () => {
    const onJump = vi.fn();
    const { user } = setup(["P1-B1", "P1-B2", "P1-B3"], { onJump });
    await user.click(screen.getByRole("button", { name: "Jump to block" }));
    await user.click(within(screen.getByRole("listbox", { name: "Selected blocks" })).getByRole("option", { name: /P1-B3/ }));
    expect(onJump).toHaveBeenCalledWith("P1-B3 - MUT");
    const third = screen.getAllByTestId("block-section")[2];
    expect(third).toHaveAttribute("data-open", "true");
    expect(third).toHaveAttribute("data-flash", "true");
    expect(third.className).toMatch(/ring-2/);
  });

  it("the X on a block's header removes it; it asks first only when chemicals are entered", async () => {
    const onRemove = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    const blocks = [blk("P1-B1"), blk("P1-B2")];
    const user = userEvent.setup();
    render(
      <BlockPlanPanel
        blocks={blocks}
        plans={{ "P1-B1 - MUT": emptyPlan(), "P1-B2 - MUT": planned([chem("X")]) }}
        onPlanChange={vi.fn()}
        onRemove={onRemove}
        boot={BOOT}
        findings={{}}
        when="2026-10-30 06:00:00"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove P1-B1 from the plan" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenLastCalledWith("P1-B1 - MUT");
    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Remove P1-B2 from the plan" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Remove P1-B2 from the plan" }));
    expect(onRemove).toHaveBeenLastCalledWith("P1-B2 - MUT");
    confirm.mockRestore();
  });

  it("required fields are marked from the start and outlined, with a message, after a submit attempt", () => {
    const b = blk("P1-B1");
    const plan = { ...emptyPlan() };
    const { rerender } = render(
      <BlockPlanPanel blocks={[b]} plans={{ [b.name]: plan }} onPlanChange={vi.fn()} boot={BOOT} findings={{}} when="2026-10-30 06:00:00" />,
    );
    const s = screen.getByTestId("block-section");
    expect(s.querySelectorAll("[data-required]").length).toBeGreaterThanOrEqual(6);
    expect(within(s).queryAllByRole("alert")).toHaveLength(0);
    rerender(
      <BlockPlanPanel blocks={[b]} plans={{ [b.name]: plan }} onPlanChange={vi.fn()} boot={BOOT} findings={{}} when="2026-10-30 06:00:00" showErrors />,
    );
    expect(within(s).getByTestId("field-error-classification")).toHaveTextContent("Choose Preventive or Curative.");
    expect(within(s).getByTestId("field-error-team")).toHaveTextContent("Pick a spray team.");
    expect(within(s).getByTestId("field-error-bom")).toBeInTheDocument();
    expect(s.querySelector("[data-field='team']")).toHaveAttribute("data-invalid", "true");
    // the outlines follow the same list as the header and the gate
    expect(within(s).getByText("Needs Preventive or Curative")).toBeInTheDocument();
    expect(within(s).queryByTestId("field-error-area")).toBeNull();
  });

  it("a complete block shows no outline even after a submit attempt", () => {
    getItemAvailability.mockResolvedValue({});
    const b = blk("P1-B1");
    render(
      <BlockPlanPanel blocks={[b]} plans={{ [b.name]: planned([chem("X")]) }} onPlanChange={vi.fn()} boot={BOOT} findings={{}} when="2026-10-30 06:00:00" showErrors />,
    );
    const s = screen.getByTestId("block-section");
    expect(s.querySelector("[data-invalid]")).toBeNull();
    expect(within(s).getByText("Ready")).toBeInTheDocument();
  });
});
