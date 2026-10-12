import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CycleMoney } from "@/lib/procurement-api";

const MONEY: CycleMoney = {
  cycle: "CPC-1",
  company: "Karen Roses",
  fiscal_year: "2026",
  currency: "KES",
  farms: [
    {
      farm: "Chepsito", cost_center: "Chepsito Farm - KR", purchase_cost_center: null,
      requirement_value: 250_000, approved_value: 219_063, allocated_value: 0,
      fy_committed: 3_068_540, budget: 2_000_000, draft_budget: null, budgets: ["BUDGET-1"],
      over_budget: true,
    },
    {
      farm: "Kapkolia", cost_center: null, purchase_cost_center: null,
      requirement_value: 235_282, approved_value: 235_282, allocated_value: 0,
      fy_committed: 235_282, budget: null, draft_budget: 235_282, budgets: [],
      over_budget: false,
    },
  ],
  warnings: ["1110009: no purchase or valuation rate on record — costed at 0"],
  over_budget: ["Chepsito"],
  totals: { requirement_value: 485_282, approved_value: 454_345, allocated_value: 0 },
};

window.SCP = { bootstrap: { roles: ["SCP General Manager"] } } as typeof window.SCP;

vi.mock("@/lib/procurement-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/procurement-api")>()),
  procurementFarms: async () => ["Chepsito"],
  itemBreakdown: async () => ({ cycle: "CPC-1", currency: "KES", farms: [], items: [] }),
  listCycles: async () => [{ name: "CPC-1", cycle_name: "October", status: "GM Review" }],
  myRequirement: async () => ({ name: "R", farm: "Chepsito", cycle: "CPC-1", status: "Draft", items: [] }),
  getCycle: async () => ({
    name: "CPC-1", cycle_name: "October", company: "Karen Roses", status: "GM Review",
    period_start: "2026-10-01", period_end: "2026-10-31", general_store: "GS - KR",
    material_request: null, notes: null, allocations: [],
    lines: [{
      item_code: "1110009", item_name: "IMPULSE EC500", uom: "Litre", total_requested: 80,
      reduction_mode: "None", reduction_value: 0, approved_qty: 80, allocation_step: 0.1,
      allocated_total: 0, remainder: 0, final_approved: false,
    }],
  }),
  cycleMoney: async () => MONEY,
}));

const { Procurement } = await import("@/pages/Procurement");

async function openConsolidated() {
  const user = userEvent.setup();
  render(<Procurement />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Consolidated" })).toBeInTheDocument());
  await user.click(screen.getByRole("tab", { name: "Consolidated" }));
  await waitFor(() => expect(screen.getByRole("table", { name: "Money by farm" })).toBeInTheDocument());
  await waitFor(() => expect(screen.getAllByText("Chepsito Farm - KR").length).toBeGreaterThan(0));
}

describe("Procurement — money next to the quantities", () => {
  it("values each farm's requirement, approval and allocation", async () => {
    await openConsolidated();
    const t = screen.getByRole("table", { name: "Money by farm" });
    for (const h of ["Requirement", "Approved", "Allocated", "Committed this year", "Budget"]) {
      expect(within(t).getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    const row = within(t).getByText("Chepsito").closest("tr")!;
    expect(within(row).getByText(/250,000/)).toBeInTheDocument();
    expect(within(row).getByText(/219,063/)).toBeInTheDocument();
    expect(within(row).getByText(/2,000,000/)).toBeInTheDocument();
  });

  it("warns, without blocking, when a farm commits more than its budget", async () => {
    await openConsolidated();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Over budget: Chepsito commits KES 3,068,540/);
    expect(alert).toHaveTextContent(/warning, not a stop/);
    expect(screen.getByRole("button", { name: /Raise Material Request/ })).toBeEnabled();
  });

  it("shows a draft budget as a draft and a missing cost centre as missing", async () => {
    await openConsolidated();
    const row = within(screen.getByRole("table", { name: "Money by farm" })).getByText("Kapkolia").closest("tr")!;
    expect(within(row).getByText(/235,282 draft/)).toBeInTheDocument();
    expect(within(row).getByText("No cost centre")).toBeInTheDocument();
  });

  it("lists costing warnings so a zero rate is never silent", async () => {
    await openConsolidated();
    expect(screen.getByText(/costed at 0/)).toBeInTheDocument();
  });
});
