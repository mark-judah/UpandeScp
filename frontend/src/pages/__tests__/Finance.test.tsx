import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChemicalCostReport } from "@/lib/finance-api";

const REPORT: ChemicalCostReport = {
  as_of: "2026-09-30T00:00:00",
  currency: "KES",
  granularity: "week",
  item_names: { CHE00058: "MAGNUM GOLD" },
  grand_total: 1000,
  attributed_total: 700,
  unattributed_total: 300,
  unattributed_share: 0.3,
  totals_by_kind: { chemical: 800, foliar: 200 },
  cost_per_target: [
    {
      target: "Spidermites", kind: "pest", basis: { history: 400 }, value: 400, share: 0.4, houses: 2,
      products: [{ item_code: "CHE00058", item_name: "MAGNUM GOLD", value: 400 }],
    },
    {
      target: "Crop nutrition & adjuvants", kind: "nutrition", basis: { nutrition: 200 }, value: 200, share: 0.2,
      houses: 1, products: [],
    },
    {
      target: "Downy Mildew", kind: "disease", basis: { registered: 100 }, value: 100, share: 0.1, houses: 1,
      products: [],
    },
  ],
  by_basis: [
    { basis: "registered", value: 100, share: 0.1 },
    { basis: "ai_class", value: 0, share: 0 },
    { basis: "history", value: 400, share: 0.4 },
    { basis: "nutrition", value: 200, share: 0.2 },
    { basis: "equal", value: 0, share: 0 },
    { basis: "unattributed", value: 300, share: 0.3 },
  ],
  unattributed: [{ farm: "Main", greenhouse: "No plan", kind: "foliar", reason: "no_plan", value: 300 }],
  by_product: [],
  by_place: [{ farm: "Main", greenhouse: "Main GH 04 - MFK", value: 700, attributed: 700, unattributed: 0 }],
  by_period: [{ period: "2026-09-07", value: 1000, attributed: 700, unattributed: 300 }],
  farms: [],
  no_valuation: [],
  ledger_fallback_lines: 0,
  reconciliation: { total: 1000, targets: 700, unattributed: 300, difference: 0 },
};

vi.mock("@/lib/finance-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/finance-api")>()),
  fetchChemicalCostByTarget: vi.fn(async () => REPORT),
  fetchSuggestedRegistrations: vi.fn(async () => []),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">menu</button>,
}));

const { Finance } = await import("@/pages/Finance");

describe("Finance page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the Unattributed line explicitly beside the targets", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("Spidermites")).toBeInTheDocument());
    expect(screen.getAllByText("Unattributed").length).toBeGreaterThan(0);
    expect(screen.getByText("Crop nutrition & adjuvants", { selector: "div" })).toBeInTheDocument();
  });

  it("states that the figures reconcile", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("To the cent")).toBeInTheDocument());
  });

  it("breaks the spend down by allocation basis", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("How the spend was assigned")).toBeInTheDocument());
    expect(screen.getByText("Registered for the target")).toBeInTheDocument();
    expect(screen.getByText("Usage history (180 days)")).toBeInTheDocument();
  });

  it("pins the filter row", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("Spidermites")).toBeInTheDocument());
    const filters = screen.getByLabelText("Farm").closest("div.sticky");
    expect(filters).not.toBeNull();
  });
});
