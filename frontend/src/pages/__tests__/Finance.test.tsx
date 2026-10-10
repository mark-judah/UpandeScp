import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChemicalCostReport } from "@/lib/finance-api";

const REPORT: ChemicalCostReport = {
  as_of: "2026-10-10T00:00:00",
  currency: "KES",
  grand_total: 122016.18,
  item_names: {
    "1110009": "IMPULSE EC500",
    "1111156005": "Amisil",
  },
  totals_by_kind: { chemical: 112016.18, foliar: 10000 },
  farms: [
    {
      farm: "Chepsito",
      targets: ["Botrytis", "Thrips", "Nutrition"],
      rows: [
        {
          greenhouse: "Chepsito GH 16 - KR",
          kind: "chemical",
          costs: {
            // pinned down by the product's own targets
            Botrytis: { value: 9547.48, attributed: 9547.48, split: 0, split_items: [] },
            // divided across the plan's targets - not a measurement
            Thrips: {
              value: 2757.91, attributed: 0, split: 2757.91,
              split_items: ["1110009", "1111156005"],
            },
            Nutrition: { value: 0, attributed: 0, split: 0, split_items: [] },
          },
          total: 12305.39,
        },
      ],
      target_totals: { Botrytis: 9547.48, Thrips: 2757.91, Nutrition: 0 },
      total: 12305.39,
    },
  ],
  cost_per_target: [
    { target: "Thrips", kind: "pest", value: 102123.98, attributed: 6903.86, split: 95220.12, share: 0.895, houses: 10 },
    { target: "Powdery Mildew", kind: "disease", value: 8427.25, attributed: 8427.25, split: 0, share: 0.0739, houses: 1 },
  ],
  unattributed: [
    { farm: "Chepsito", cost_center: "Main - KR", kind: "foliar", value: 4326894.71 },
    { farm: "Kapkolia", cost_center: "Main - KR", kind: "chemical", value: 6020912.13 },
  ],
  untargeted_items: [
    { item_code: "FER00008", item_name: "CALCIUM NITRATE (Yara)", kind: "foliar", value: 1852398.57 },
  ],
  no_valuation: [
    {
      stock_entry: "MAT-STE-2026-04612", posting_date: "2026-09-23",
      item_code: "1111156005", item_name: "Amisil", kind: "chemical",
      qty: 2, uom: "Kilogram", greenhouse: "Torongo GH 13 - KR", farm: "Torongo",
    },
  ],
};

const fetchMock = vi.fn(async (..._args: unknown[]) => REPORT);

vi.mock("@/lib/finance-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/finance-api")>()),
  fetchChemicalCostByTarget: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">menu</button>,
}));

const { Finance } = await import("@/pages/Finance");

describe("Finance page", () => {
  beforeEach(() => fetchMock.mockClear());

  it("asks for the route crop's farms only", async () => {
    render(<Finance initialCrop="Rose" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][2]).toEqual({ crop: "Rose" });
  });

  it("marks a split figure so it cannot be read as measured", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("~100%")).toBeInTheDocument());
  });

  it("does not mark a genuinely attributed figure", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getAllByText(/9,547/).length).toBeGreaterThan(0));
    // Only one marker in the greenhouse table — the attributed cell carries none.
    const table = screen.getByText("Chepsito GH 16 - KR").closest("table")!;
    expect(within(table).getAllByText(/^~\d+%$/)).toHaveLength(1);
  });

  it("says what is counted, and that it is counted once", async () => {
    render(<Finance />);
    await waitFor(() =>
      expect(screen.getByText(/counted once, where it leaves the store/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/loaning between farms/i)).toBeInTheDocument();
  });

  it("answers what treating each pest cost, with its share and houses", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("Cost per target")).toBeInTheDocument());
    const table = screen.getByRole("table", { name: "Cost per target" });
    const row = within(table).getByText("Powdery Mildew").closest("tr")!;
    expect(within(row).getByText(/8,427/)).toBeInTheDocument();
    expect(within(row).getByText("7.4%")).toBeInTheDocument();
    expect(within(row).getByText("1")).toBeInTheDocument();
    const thrips = within(table).getByText("Thrips").closest("tr")!;
    expect(within(thrips).getByText("89.5%")).toBeInTheDocument();
    // most of Thrips is split, and the summary says so
    expect(within(thrips).getByText("~93%")).toBeInTheDocument();
  });

  it("lists consumed lines with no valuation so missing costs are visible", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("No valuation")).toBeInTheDocument());
    expect(screen.getByText("MAT-STE-2026-04612")).toBeInTheDocument();
    expect(screen.getByText(/2 Kilogram/)).toBeInTheDocument();
  });

  it("reports store-issued spend as unattributed, by farm and both kinds", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("Unattributed spend")).toBeInTheDocument());
    expect(screen.getByText(/no greenhouse and no target/i)).toBeInTheDocument();
    expect(screen.getByText(/4,326,895/)).toBeInTheDocument();
    expect(screen.getByText(/6,020,912/)).toBeInTheDocument();
    expect(screen.getByText("Kapkolia")).toBeInTheDocument();
  });

  it("lists the products with no targets as an actionable backlog", async () => {
    render(<Finance />);
    await waitFor(() =>
      expect(screen.getByText("Products with no targets recorded")).toBeInTheDocument(),
    );
    expect(screen.getByText("CALCIUM NITRATE (Yara)")).toBeInTheDocument();
    expect(screen.getByText("FER00008")).toBeInTheDocument();
  });

  it("names the split products, not just their codes", async () => {
    const user = userEvent.setup();
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("~100%")).toBeInTheDocument());
    await user.hover(screen.getByText("~100%"));
    await waitFor(() =>
      expect(screen.getAllByText("IMPULSE EC500").length).toBeGreaterThan(0),
    );
  });

  it("pins the greenhouse column and scrolls the rest inside the table", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("Chepsito GH 16 - KR")).toBeInTheDocument());
    const cell = screen.getByText("Chepsito GH 16 - KR");
    expect(cell.className).toContain("sticky");
    expect(cell.className).toContain("left-0");
    expect(cell.closest("div.overflow-x-auto")).not.toBeNull();
  });

  it("shows chemical and foliar totals separately", async () => {
    render(<Finance />);
    await waitFor(() => expect(screen.getAllByText(/122,016/).length).toBeGreaterThan(0));
    expect(screen.getByText(/112,016/)).toBeInTheDocument();
    expect(screen.getByText(/10,000/)).toBeInTheDocument();
  });
});
