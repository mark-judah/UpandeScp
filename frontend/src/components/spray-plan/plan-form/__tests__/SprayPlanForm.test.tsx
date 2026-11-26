import { useEffect } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select needs these in jsdom.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const api = vi.hoisted(() => ({
  fetchBomDetails: vi.fn(),
  getItemAvailability: vi.fn(),
  fetchChemicalBalances: vi.fn(),
  searchChemicalItems: vi.fn(),
  createBom: vi.fn(),
}));
vi.mock("@/lib/scouting-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/scouting-api")>()),
  ...api,
}));
vi.mock("@/lib/teams-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/teams-api")>()),
  fetchSprayTeams: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/schedule-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/schedule-api")>()),
  fetchCrewAvailability: vi.fn().mockResolvedValue(null),
}));
const suggest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/spray-compliance-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-compliance-api")>()),
  eligibleProducts: vi.fn().mockResolvedValue([]),
  suggestProducts: (...a: unknown[]) => suggest(...a),
}));
vi.mock("@/components/BomPicker", () => ({
  BomPicker: (p: { value: string; onValueChange: (v: string) => void }) => (
    <button type="button" data-testid="bom" onClick={() => p.onValueChange("BOM-1")}>
      {p.value || "Select tank mix"}
    </button>
  ),
}));

import { SuggestedProductsCard } from "@/components/spray-plan/SuggestedProducts";
import { SprayPlanForm } from "@/components/spray-plan/plan-form/SprayPlanForm";
import { useSprayPlanForm, type PlanFormState } from "@/components/spray-plan/plan-form/useSprayPlanForm";

const BOM = {
  name: "BOM-1",
  custom_water_ph: 7,
  custom_water_hardness: 100,
  chemicals: [{ item_code: "X", item_name: "Xchem", stock_qty: 2, stock_uom: "Litre", balances: { "Store - K": 10 } }],
  chemical_warehouses: ["Store - K"],
  fertilizer_warehouses: [],
};

const avail = (over: Record<string, unknown> = {}) => ({
  ledger: 10, reserved: 3, reserved_submitted: 1, reserved_by: [], has_batch_no: 0, batches: [], ...over,
});

let latest: PlanFormState | null = null;

function Harness({ onCreated, withBom = true }: { onCreated?: (n: string) => Promise<void> | void; withBom?: boolean }) {
  const state = useSprayPlanForm({
    place: "Karen GH1",
    placeKind: "greenhouse",
    farm: "Karen",
    areaHa: 0.5,
    stores: { chemical_store: "Store - K", fertilizer_store: null },
  });
  latest = state;
  useEffect(() => {
    state.setWater("1000");
    if (withBom) state.setBom("BOM-1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <SprayPlanForm
      state={state}
      teams={[{ name: "Spray 1", members: [{ employee: "EMP-1", employee_name: "Jane Wanjiru", role: "Supervisor" }, { employee: "EMP-2", employee_name: "Paul Otieno", role: "Sprayer" }] } as any]}
      kits={[{ kit: "Kit 1" }]}
      showMethod
      boms={[{ name: "BOM-1", item_name: "Mix 1" }]}
      onTankMixCreated={onCreated}
      suggestionsSlot={
        <SuggestedProductsCard
          embedded
          collapsible
          targets={["Thrips"]}
          greenhouses={["Karen GH1"]}
          sourceWarehouse="Store - K"
          currentItems={state.chemicals.map((c) => c.item_code)}
          canAdd
          onAdd={(p) => void state.addChemical({ item_code: p.item_code, item_name: p.item_name, stock_uom: p.stock_uom }, p.default_rate, "Store - K")}
        />
      }
    />
  );
}

beforeEach(() => {
  latest = null;
  api.fetchBomDetails.mockReset().mockResolvedValue(BOM);
  api.getItemAvailability.mockReset().mockResolvedValue({ X: avail() });
  api.fetchChemicalBalances.mockReset().mockResolvedValue({ Y: { "Store - K": 4 } });
  api.searchChemicalItems.mockReset().mockResolvedValue([{ item_code: "Y", item_name: "Ychem", stock_uom: "Kg" }]);
  suggest.mockReset().mockResolvedValue({
    suggestions: [{ item_code: "S1", item_name: "Suggested One", stock_uom: "Litre", dots: 4, score: 80, eligible: true, warnings: [], covered_targets: ["Thrips"], reason: "Registered", default_rate: 1 }],
    covered: [], remaining_targets: ["Thrips"], all_covered: false,
  });
  api.createBom.mockReset().mockResolvedValue({ status: "success", bom_name: "BOM-NEW" });
});

describe("SprayPlanForm", () => {
  it("puts Spray team, Kit and MOA on one row, MOA with its tooltip", () => {
    render(<Harness withBom={false} />);
    const row = screen.getByTestId("team-kit-moa");
    expect(within(row).getByRole("combobox", { name: "Spray team" })).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "Kit" })).toBeInTheDocument();
    const moa = within(row).getByTitle("Method of application");
    expect(moa).toHaveTextContent("MOA");
    expect(within(row).getByRole("combobox", { name: "Method of application" })).toHaveTextContent("Spraying (foliar)");
  });

  it("New tank mix opens the create dialog", async () => {
    const user = userEvent.setup();
    render(<Harness withBom={false} />);
    await user.click(screen.getByRole("button", { name: /New tank mix/ }));
    expect(await screen.findByRole("dialog", { name: "Create a new tank mix" })).toBeInTheDocument();
  });

  it("a tank mix made in the dialog is selected afterwards", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn().mockResolvedValue(undefined);
    render(<Harness withBom={false} onCreated={onCreated} />);
    await user.click(screen.getByRole("button", { name: /New tank mix/ }));
    const dlg = await screen.findByRole("dialog", { name: "Create a new tank mix" });
    await user.type(within(dlg).getByPlaceholderText(/Botrytis Mix/), "My mix");
    await user.click(await within(dlg).findByRole("button", { name: /Ychem/ }));
    await user.type(within(dlg).getByLabelText(/Dose per 1000 L for Ychem/), "2");
    await user.click(within(dlg).getByRole("button", { name: "Create tank mix" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("BOM-NEW"));
    await waitFor(() => expect(latest?.bom).toBe("BOM-NEW"));
    expect(api.fetchBomDetails).toHaveBeenCalledWith("BOM-NEW", "Karen GH1");
  });

  it("Add chemical adds a row to the table", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const table = await screen.findByTestId("chemical-table");
    expect(within(table).getByText("Xchem")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add chemical" }));
    const dlg = await screen.findByRole("dialog", { name: "Add chemical" });
    await user.click(await within(dlg).findByRole("button", { name: /Ychem/ }));
    await waitFor(() => expect(within(screen.getByTestId("chemical-table")).getByText("Ychem")).toBeInTheDocument());
    expect(latest?.chemicals.map((c) => c.item_code)).toEqual(["X", "Y"]);
  });

  it("shows the roses Available figure: on hand less other drafts' reservations", async () => {
    render(<Harness />);
    const table = await screen.findByTestId("chemical-table");
    // 10 on hand at the farm store - 3 reserved by other open plans = 7
    await waitFor(() => expect(within(table).getByTestId("available-X")).toHaveTextContent(/^7/));
    // the quantity is the per-1000 L rate x 1000 L of water
    expect(within(table).getByTestId("qty-X")).toHaveTextContent("2.00");
  });

  it("has no Batch column while no row needs a batch", async () => {
    render(<Harness />);
    const table = await screen.findByTestId("chemical-table");
    await waitFor(() => expect(within(table).getByTestId("available-X")).toHaveTextContent(/^7/));
    expect(within(table).queryByRole("columnheader", { name: "Batch" })).toBeNull();
  });

  it("adds the Batch column for a batch-tracked item and blocks until one is picked", async () => {
    api.getItemAvailability.mockResolvedValue({
      X: avail({
        has_batch_no: 1, batch_required: true,
        batches: [{ batch_no: "B-1", qty: 1, expiry_date: null, reserved: 0, available: 1, placeholder: false, expired: false }],
      }),
    });
    render(<Harness />);
    const table = await screen.findByTestId("chemical-table");
    expect(await within(table).findByRole("columnheader", { name: "Batch" })).toBeInTheDocument();
    expect(within(table).getByRole("combobox", { name: "Batch for Xchem" })).toBeInTheDocument();
    // B-1 holds 1 but the row needs 2: not pre-selected, so the plan is blocked
    expect(latest?.batchMissingRows.map((c) => c.item_code)).toEqual(["X"]);
  });
});

describe("SprayPlanForm additions", () => {
  it("picking a spray team shows its members with their roles under the pill", async () => {
    const user = userEvent.setup();
    render(<Harness withBom={false} />);
    expect(screen.queryByTestId("plan-crew")).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Spray team" }));
    await user.click(await screen.findByRole("option", { name: "Spray 1" }));
    const crew = await screen.findByTestId("plan-crew");
    expect(within(crew).getByText("Jane Wanjiru")).toBeInTheDocument();
    expect(within(crew).getByText("Paul Otieno")).toBeInTheDocument();
    expect(latest?.members.map((m) => [m.employee, m.role])).toEqual([["EMP-1", "Supervisor"], ["EMP-2", "Sprayer"]]);
  });

  it("Suggested products is a closed pill with a count; opening it and picking one adds a row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByTestId("chemical-table");
    const pill = await screen.findByRole("button", { name: /Suggested products \(1\)/ });
    expect(pill).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("suggest-S1")).toBeNull();
    await user.click(pill);
    await user.click(await screen.findByTestId("suggest-S1"));
    await waitFor(() => expect(within(screen.getByTestId("chemical-table")).getByText("Suggested One")).toBeInTheDocument());
  });
});
