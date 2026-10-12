import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ItemBreakdown } from "@/lib/procurement-api";

const BREAKDOWN: ItemBreakdown = {
  cycle: "CPC-1",
  currency: "KES",
  farms: [
    { farm: "Chepsito", status: "Planner Approved", requirement: "R1" },
    { farm: "Kapkolia", status: "Submitted", requirement: "R2" },
  ],
  items: [
    {
      item_code: "1110009", item_name: "IMPULSE EC500", uom: "Litre", rate: 100,
      by_farm: {
        Chepsito: { requested: 30, approved: 25, status: "Planner Approved", counted: true },
        Kapkolia: { requested: 70, approved: null, status: "Submitted", counted: false },
      },
      total_requested: 100, total_approved: 25, requested_value: 10000, approved_value: 2500,
    },
  ],
};

window.SCP = { bootstrap: { roles: ["SCP General Manager"] } } as typeof window.SCP;

const calls = {
  listCycles: vi.fn(async () => [{ name: "CPC-1", cycle_name: "October", status: "GM Review" }]),
  procurementFarms: vi.fn(async () => ["Chepsito", "Kapkolia"]),
  itemBreakdown: vi.fn(async () => BREAKDOWN),
  fetchInsights: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => {
    throw new Error("n/a");
  }),
};

vi.mock("@/lib/procurement-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/procurement-api")>()),
  listCycles: (...a: unknown[]) => (calls.listCycles as (...x: unknown[]) => unknown)(...a),
  procurementFarms: (...a: unknown[]) => (calls.procurementFarms as (...x: unknown[]) => unknown)(...a),
  itemBreakdown: (...a: unknown[]) => (calls.itemBreakdown as (...x: unknown[]) => unknown)(...a),
  fetchInsights: (...a: unknown[]) => (calls.fetchInsights as (...x: unknown[]) => unknown)(...a),
  requirementsFor: async () => [],
  listAmendments: async () => [],
  myRequirement: async () => ({
    name: "R1", farm: "Chepsito", cycle: "CPC-1", status: "Draft",
    items: [{ item_code: "1110009", item_name: "IMPULSE EC500", uom: "Litre", requested_qty: 30 }],
  }),
}));

const { Procurement } = await import("@/pages/Procurement");
const { InsightLine } = await import("@/components/procurement/InsightLine");

describe("Procurement — scoped to the route crop", () => {
  it("asks for cycles and farms with the route's crop, and the picker offers only those farms", async () => {
    const user = userEvent.setup();
    render(<Procurement initialCrop="Rose" />);
    await waitFor(() => expect(calls.listCycles).toHaveBeenCalledWith(undefined, "Rose"));
    await waitFor(() => expect(calls.procurementFarms).toHaveBeenCalledWith("Rose", "CPC-1"));
    await user.click(await screen.findByRole("button", { name: "Farm" }));
    const opts = within(await screen.findByRole("listbox")).getAllByRole("option").map((o) => o.textContent);
    expect(opts).toEqual(["Chepsito", "Kapkolia"]);
  });
});

describe("Review — quantities by farm", () => {
  async function openReview() {
    const user = userEvent.setup();
    render(<Procurement initialCrop="Rose" />);
    await user.click(await screen.findByRole("tab", { name: "Review" }));
    return screen.findByRole("table", { name: "Quantities by farm" });
  }

  it("has a column per requesting farm, the total, and the value", async () => {
    const t = await openReview();
    for (const h of ["Chepsito", "Kapkolia", "Total", "Value"]) {
      expect(within(t).getByRole("columnheader", { name: new RegExp(h) })).toBeInTheDocument();
    }
    const row = within(t).getByText("IMPULSE EC500").closest("tr")!;
    expect(within(row).getByText("30 → 25")).toBeInTheDocument(); // asked → GM-cut share
    expect(within(row).getByText("70")).toBeInTheDocument(); // not approved yet: just the ask
    expect(within(row).getByText("100 → 25")).toBeInTheDocument();
    expect(within(row).getByText(/KES 2,500/)).toBeInTheDocument();
    expect(calls.itemBreakdown).toHaveBeenCalledWith("CPC-1", "Rose");
  });

  it("marks a farm whose requirement is not approved yet as pending", async () => {
    const t = await openReview();
    const kap = within(t).getByRole("columnheader", { name: /Kapkolia/ });
    expect(within(kap).getByText("pending")).toBeInTheDocument();
    const chep = within(t).getByRole("columnheader", { name: /Chepsito/ });
    expect(within(chep).queryByText("pending")).toBeNull();
  });

  it("opens the farm split under a line in the Consolidated tab", async () => {
    const user = userEvent.setup();
    const api = await import("@/lib/procurement-api");
    vi.spyOn(api, "getCycle").mockResolvedValue({
      name: "CPC-1", cycle_name: "October", company: "Karen Roses", status: "GM Review",
      period_start: null, period_end: null, general_store: null, material_request: null,
      notes: null, allocations: [],
      lines: [{
        item_code: "1110009", item_name: "IMPULSE EC500", uom: "Litre", total_requested: 100,
        reduction_mode: "None", reduction_value: 0, approved_qty: 100, allocation_step: 0.1,
        allocated_total: 0, remainder: 0, final_approved: false,
      }],
    });
    vi.spyOn(api, "cycleMoney").mockRejectedValue(new Error("n/a"));
    render(<Procurement initialCrop="Rose" />);
    await user.click(await screen.findByRole("tab", { name: "Consolidated" }));
    const toggle = await screen.findByRole("button", { name: "Farms for IMPULSE EC500" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("30 → 25")).toBeInTheDocument();
  });
});

describe("InsightLine", () => {
  const insight = {
    on_hand: 42, consumed: 12, last_approved: 17, last_cycle: "CPC-0", credit: 3.5, rate: 100, uom: "Kg",
  };

  it("shows on hand, 8-week use, last cycle, credit, rate and the value of the typed quantity", () => {
    render(<InsightLine state={{ status: "ready", insight }} qty={5} currency="KES" />);
    const line = screen.getByTestId("insight");
    expect(line).toHaveTextContent("On hand 42 Kg");
    expect(line).toHaveTextContent("Used 8 wk 12 Kg");
    expect(line).toHaveTextContent("Last cycle 17 Kg");
    expect(line).toHaveTextContent("Credit 3.5 Kg");
    expect(line).toHaveTextContent("Rate KES 100/Kg");
    expect(line).toHaveTextContent("This order KES 500");
    expect(line.className).toMatch(/text-muted-foreground/);
    expect(line.className).toMatch(/tabular-nums/);
  });

  it("is a skeleton while loading and a dash on error", () => {
    const { rerender } = render(<InsightLine state={{ status: "loading" }} qty={1} />);
    expect(screen.getByTestId("insight")).toHaveAttribute("data-loading", "true");
    rerender(<InsightLine state={{ status: "error" }} qty={1} />);
    expect(screen.getByTestId("insight")).toHaveTextContent("—");
  });

  it("never invents a zero for a figure it does not have", () => {
    render(
      <InsightLine
        state={{ status: "ready", insight: { ...insight, last_approved: null, credit: 0, rate: 0 } }}
        qty={5}
      />,
    );
    const line = screen.getByTestId("insight");
    expect(line).toHaveTextContent("Last cycle —");
    expect(line).toHaveTextContent("Rate —");
    expect(line).toHaveTextContent("This order —");
  });
});

describe("My requirement — the insight under a chemical", () => {
  it("asks once for the farm's chemicals and shows the line under the row", async () => {
    calls.fetchInsights.mockResolvedValue({
      farm: "Chepsito", weeks: 8, currency: "KES",
      items: { "1110009": { on_hand: 9, consumed: 4, last_approved: 20, last_cycle: "C0", credit: 0, rate: 50, uom: "Litre" } },
    });
    render(<Procurement initialCrop="Rose" />);
    await waitFor(() => expect(calls.fetchInsights).toHaveBeenCalledWith("Chepsito", ["1110009"], "CPC-1"));
    const line = await screen.findByText(/On hand/);
    expect(line.closest("[data-testid=insight]")).toHaveTextContent("Used 8 wk 4 Litre");
    expect(line.closest("[data-testid=insight]")).toHaveTextContent("This order KES 1,500"); // 30 x 50
  });

  it("falls back to a dash when the insights call fails", async () => {
    calls.fetchInsights.mockRejectedValue(new Error("boom"));
    render(<Procurement initialCrop="Rose" />);
    await waitFor(() => expect(screen.getByTestId("insight")).toHaveTextContent("—"));
  });
});

describe("Procurement — header alignment", () => {
  it("pads once: the page wrapper adds no gutter on top of PageHeader's, so tabs, title and filters share an edge", async () => {
    const { container } = render(<Procurement initialCrop="Rose" />);
    await screen.findByRole("tab", { name: "Review" });
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toMatch(/(^|\s)(md:)?p-\d/);
    expect(root.className).not.toMatch(/(^|\s)(md:)?px-\d/);
    const header = screen.getByRole("heading", { name: "Chemical Procurement" }).closest("header")!;
    expect(header.className).toMatch(/px-4/);
    const filters = screen.getByRole("button", { name: "Farm" }).closest("div.px-4");
    expect(filters).not.toBeNull();
  });
});
