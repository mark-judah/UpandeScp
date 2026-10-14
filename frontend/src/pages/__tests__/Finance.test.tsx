import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PathBlock, PestAttributionReport } from "@/lib/finance-api";

const ACC = {
  spray: { recorded: 1, band1_ai_target: 0.89, band1_ai_class: 0.64, band2_alone: 0.93, band3_radar: 0.67, equal: 0.38 },
  direct: { band2_alone: 0.84, band3_radar: 0.45 },
};

const SPRAY: PathBlock = {
  path: "spray",
  total: 1000,
  plans_completed: 12,
  in_progress: { plans: 3, value: 250 },
  chemical: {
    total: 800,
    recorded: 300,
    derived: 400,
    unattributed: 100,
    derived_accuracy: 0.85,
    by_pest: [
      {
        target: "Spidermites", kind: "pest", recorded: 300, derived: 100, value: 400, share: 0.5, est_accuracy: 0.89,
        basis: { recorded: 300, band1_ai_target: 100 },
        products: [{ item_code: "CHE1", item_name: "MAGNUM GOLD", value: 400 }],
      },
      {
        target: "Downy Mildew", kind: "disease", recorded: 0, derived: 300, value: 300, share: 0.375, est_accuracy: 0.67,
        basis: { band3_radar: 300 }, products: [],
      },
    ],
  },
  nonpest: {
    total: 200,
    groups: [
      { group: "Foliar", treatment: "split equally across the plan's targets; not target-specific on direct issues", value: 200, farm_level: 0, by_target: [{ target: "Spidermites", value: 120 }, { target: "Downy Mildew", value: 80 }] },
      { group: "Adjuvant", treatment: "split equally across the plan's targets; not target-specific on direct issues", value: 0, farm_level: 0, by_target: [] },
      { group: "pH buffer", treatment: "split equally across the plan's targets; not target-specific on direct issues", value: 0, farm_level: 0, by_target: [] },
      { group: "Hygiene & sanitation", treatment: "not target-specific, never split to pests", value: 0, farm_level: 0, by_target: [] },
      { group: "Post-harvest", treatment: "not target-specific, never split to pests", value: 0, farm_level: 0, by_target: [] },
      { group: "Unclassified", treatment: "not placed: never used on a spray plan and no ingredient known. Set its cost group", value: 0, farm_level: 0, by_target: [] },
    ],
  },
  by_basis: [
    { basis: "recorded", value: 300, share: 0.3, kind: "recorded", label: "Recorded", accuracy: 1 },
    { basis: "band1_ai_target", value: 100, share: 0.1, kind: "derived", label: "Derived", accuracy: 0.89 },
    { basis: "band3_radar", value: 300, share: 0.3, kind: "derived", label: "Derived", accuracy: 0.67 },
    { basis: "foliar_equal", value: 200, share: 0.2, kind: "nonpest", label: "Foliar", accuracy: null },
    { basis: "unattributed", value: 100, share: 0.1, kind: "unattributed", label: "Unattributed", accuracy: null },
  ],
  by_product: [],
  by_greenhouse: [{ farm: "Main", greenhouse: "Main GH 04 - MFK", cost_center: "GH004 - MFK", chemical: 800, nonpest: 200, value: 1000, targets: {} }],
};
const DIRECT: PathBlock = {
  path: "direct",
  total: 500,
  explain: "Direct issues name no greenhouse.",
  by_source: { from_material_request: 450, no_material_request: 50 },
  chemical: { total: 100, recorded: 0, derived: 0, unattributed: 100, derived_accuracy: null, by_pest: [] },
  nonpest: {
    total: 400,
    groups: [
      { group: "Foliar", treatment: "split equally across the plan's targets; not target-specific on direct issues", value: 300, farm_level: 300, by_target: [] },
      { group: "Unclassified", treatment: "not placed: never used on a spray plan and no ingredient known. Set its cost group", value: 100, farm_level: 100, by_target: [] },
    ],
  },
  by_basis: [],
  by_product: [
    { item_code: "CHE10", item_name: "VELUM PRIME", nonpest: false, group: "Pest control", plan_uses: 5, value: 90, from_mr: 90, targets: [{ target: "Nematodes", value: 90 }] },
  ],
  by_greenhouse: [{ farm: "Main", greenhouse: "Farm level — issue has no greenhouse", cost_center: "Production - MFK", chemical: 100, nonpest: 400, value: 500, targets: {} }],
};
const REPORT: PestAttributionReport = {
  filters: { from: "2026-09-01", to: "2026-09-30", paths: ["spray", "direct"], pests: [], greenhouse: "" },
  notes: [],
  accuracy: ACC,
  pest_options: ["Spidermites", "Downy Mildew"],
  greenhouse_options: ["Main GH 04 - MFK"],
  spray: SPRAY,
  direct: DIRECT,
  combined: { total: 1500, spray: 1000, direct: 500, line_total: 1500, ledger_total: 1500, ledger_difference: 0, fallback_lines: 0, reconciles: true },
};

vi.mock("@/lib/finance-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/finance-api")>()),
  fetchPestAttribution: vi.fn(async () => REPORT),
  fetchSuggestedRegistrations: vi.fn(async () => []),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">menu</button>,
}));

const { Finance } = await import("@/pages/Finance");
const api = await import("@/lib/finance-api");

describe("Finance page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the two paths as separate sections", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByRole("region", { name: "Through spray plans" })).toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Direct material issues" })).toBeInTheDocument();
    expect(screen.getByText("12 completed plans. Only plans that were manufactured and issued to a greenhouse count.")).toBeInTheDocument();
  });

  it("marks derived figures as estimates and recorded ones as solid", async () => {
    const { container } = render(<Finance />);
    await waitFor(() => expect(screen.getAllByText("Spidermites").length).toBeGreaterThan(0));
    expect(screen.getAllByText(/^est\./).length).toBeGreaterThan(0);
    expect(screen.getAllByText("est. 89%").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-seg="recorded"]')).not.toBeNull();
    expect(container.querySelector('[data-seg="derived"]')).not.toBeNull();
    expect(screen.getAllByText("Recorded").length).toBeGreaterThan(0);
  });

  it("lists non-pest inputs as separate lines per cost group, never inside the pest rows", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getAllByText("Non-pest inputs").length).toBeGreaterThan(0));
    const spray = screen.getByTestId("nonpest-spray");
    for (const g of ["Foliar", "Adjuvant", "pH buffer", "Hygiene & sanitation", "Post-harvest"]) {
      expect(spray).toHaveTextContent(g);
    }
    expect(spray).toHaveTextContent("never split to pests");
    expect(spray).toHaveTextContent("split equally across the plan's targets");
    expect(screen.getByTestId("nonpest-direct")).toHaveTextContent("Set the cost group of these products");
  });

  it("shows plain numbers with 2 decimals and no currency anywhere", async () => {
    const { container } = render(<Finance />);
    await waitFor(() => expect(screen.getAllByText("1,000.00").length).toBeGreaterThan(0));
    expect(container.textContent).not.toMatch(/KES|Ksh|USD|\$|€|£/);
  });

  it("badges direct-issue products that are also used in spray plans", async () => {
    render(<Finance />);
    screen.getByLabelText("Breakdown per product").click();
    await waitFor(() => expect(screen.getByText("Used in spray plans (5)")).toBeInTheDocument());
  });

  it("shows the direct path at farm level with its cost centre and the combined total", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("Farm level — issue has no greenhouse")).toBeInTheDocument());
    expect(screen.getByText("Production - MFK")).toBeInTheDocument();
    expect(screen.getByText("Combined total")).toBeInTheDocument();
    expect(screen.getByText("Reconciles")).toBeInTheDocument();
  });

  it("shows the by-product table only when the breakdown is on", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getAllByText("By greenhouse").length).toBeGreaterThan(0));
    expect(screen.queryByText("By product")).toBeNull();
    screen.getByLabelText("Breakdown per product").click();
    await waitFor(() => expect(screen.getAllByText("By product").length).toBeGreaterThan(0));
  });

  it("pins the filter row and offers the export with the current filters", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getAllByText("Spidermites").length).toBeGreaterThan(0));
    expect(screen.getByLabelText("Pests").closest("div.sticky")).not.toBeNull();
    const link = screen.getByText("Export Excel").closest("a") as HTMLAnchorElement;
    expect(link.href).toContain("export_pest_attribution");
    expect(link.href).toContain("path=both");
    expect(api.fetchPestAttribution).toHaveBeenCalled();
  });
});

describe("credibilityLabel", () => {
  it("labels recorded and derived distinctly, with the backtested accuracy", () => {
    expect(api.credibilityLabel("recorded", "spray", ACC).label).toBe("Recorded");
    expect(api.credibilityLabel("band1_ai_target", "spray", ACC).label).toBe("Derived — est. 89%");
    expect(api.credibilityLabel("band2_alone", "direct", ACC).label).toBe("Derived — est. 84%");
    expect(api.credibilityLabel("equal", "spray", ACC).label).toBe("Derived — est. 38%");
  });
});
