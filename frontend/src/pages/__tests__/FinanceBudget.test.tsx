import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BudgetReport, ChemicalCostReport } from "@/lib/finance-api";

const fig = (o: Partial<Record<string, number | null>>) => ({
  actual: 0, budget: 0, draft_budget: 0, approved: 0, stock_based: 0, reconciling: 0, ...o,
});

const BUDGET: BudgetReport = {
  as_of: "2026-10-12T00:00:00",
  currency: "KES",
  from_date: "2026-09-01",
  to_date: "2026-09-30",
  fiscal_years: { "Karen Roses": ["2026"] },
  farms: [
    {
      farm: "Chepsito", company: "Karen Roses", cost_center: "Chepsito Farm - KR", mapped: true,
      ...fig({ actual: 1_200_000, budget: 1_000_000, approved: 900_000, stock_based: 1_450_000, reconciling: 250_000 }),
      kinds: {
        chemical: fig({ actual: 1_000_000, budget: 800_000, stock_based: 1_300_000, reconciling: 300_000 }),
        foliar: fig({ actual: 200_000, budget: 200_000, stock_based: 150_000, reconciling: -50_000 }),
      },
    },
    {
      farm: "Torongo", company: "Karen Roses", cost_center: null, mapped: false,
      ...fig({ actual: null, stock_based: 40_000, reconciling: null }),
      kinds: {
        chemical: fig({ actual: null, stock_based: 40_000, reconciling: null }),
        foliar: fig({ actual: null, reconciling: null }),
      },
    },
  ],
  outside: [{ company: "Karen Roses", cost_center: "Main - KR", kind: "chemical", amount: 8_957_910 }],
  outside_total: 8_957_910,
  stock_unassigned: 0,
  totals: { actual: 1_200_000, budget: 1_000_000, draft_budget: 0, approved: 900_000, stock_based: 1_450_000, reconciling: 250_000 },
  notes: ["No cost-centre group on Torongo — set the farm's cost-centre group."],
};

const TARGET = {
  as_of: "", currency: "KES", grand_total: 0, item_names: {}, totals_by_kind: { chemical: 0, foliar: 0 },
  farms: [], cost_per_target: [], unattributed: [], untargeted_items: [], no_valuation: [],
} as ChemicalCostReport;

const budgetMock = vi.fn(async (..._a: unknown[]) => BUDGET);
const targetMock = vi.fn(async (..._a: unknown[]) => TARGET);

vi.mock("@/lib/finance-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/finance-api")>()),
  fetchChemicalCostByTarget: (...a: unknown[]) => targetMock(...a),
  fetchBudgetVsActual: (...a: unknown[]) => budgetMock(...a),
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">menu</button>,
}));

const { Finance } = await import("@/pages/Finance");

async function openBudget() {
  const user = userEvent.setup();
  render(<Finance initialCrop="Rose" />);
  await user.click(screen.getByRole("tab", { name: "Budget" }));
  await waitFor(() => expect(screen.getByText("Chepsito Farm - KR")).toBeInTheDocument());
}

describe("Finance — Budget view", () => {
  beforeEach(() => {
    budgetMock.mockClear();
    targetMock.mockClear();
  });

  it("is a second view; the target report stays the default", async () => {
    render(<Finance />);
    expect(screen.getByRole("tab", { name: "By target" })).toHaveAttribute("data-state", "active");
    await waitFor(() => expect(targetMock).toHaveBeenCalled());
    expect(budgetMock).not.toHaveBeenCalled();
  });

  it("asks for the route crop's farms and the chosen period", async () => {
    await openBudget();
    const [from, to, opts] = budgetMock.mock.calls[0];
    expect(typeof from).toBe("string");
    expect(typeof to).toBe("string");
    expect(opts).toEqual({ crop: "Rose" });
  });

  it("shows each farm's ledger actual against its budget, by kind", async () => {
    await openBudget();
    const table = screen.getByRole("table", { name: "Actual against budget" });
    const row = within(table).getByText("Chepsito").closest("tr")!;
    expect(within(row).getByText(/1,200,000/)).toBeInTheDocument();
    expect(within(row).getByText(/1,000,000/)).toBeInTheDocument();
    expect(within(row).getByLabelText("Over budget")).toBeInTheDocument();
    expect(within(table).getAllByText("Chemicals").length).toBeGreaterThan(0);
    expect(within(table).getAllByText("Foliars").length).toBeGreaterThan(0);
  });

  it("carries the reconciling line and says what it is", async () => {
    await openBudget();
    const row = screen.getByText("Chepsito").closest("tr")!;
    expect(within(row).getByText(/250,000/)).toBeInTheDocument();
    expect(screen.getByText(/moved into a CSU but not yet sprayed/i)).toBeInTheDocument();
  });

  it("marks a farm with no cost centre instead of showing a zero", async () => {
    await openBudget();
    const row = screen.getByText("Torongo").closest("tr")!;
    expect(within(row).getByText("No cost centre")).toBeInTheDocument();
    expect(screen.getByText(/No cost-centre group on Torongo/)).toBeInTheDocument();
  });

  it("lists expense booked outside every farm, such as Main", async () => {
    await openBudget();
    const t = screen.getByRole("table", { name: "Booked outside the farms" });
    expect(within(t).getByText("Main - KR")).toBeInTheDocument();
    expect(within(t).getByText(/8,957,910/)).toBeInTheDocument();
  });
});
