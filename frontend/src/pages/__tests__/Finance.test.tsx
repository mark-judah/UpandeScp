import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChemicalCostReport } from "@/lib/finance-api";

const REPORT: ChemicalCostReport = {
  as_of: "2026-08-25T00:00:00",
  currency: "KES",
  grand_total: 20964894.18,
  item_names: {
    CHE00058: "MAGNUM GOLD",
    CHE00025: "TECAMIN MAX",
    CHE00043: "RIDOMIL GOLD",
  },
  totals_by_kind: { chemical: 11637699.47, foliar: 9327194.71 },
  farms: [
    {
      farm: "Main",
      targets: ["Downy Mildew", "Spidermites", "Nutrition"],
      rows: [
        {
          greenhouse: "Main GH 04 - MFK",
          kind: "chemical",
          costs: {
            // pinned down by the product's own targets
            "Downy Mildew": {
              value: 9547.48, attributed: 9547.48, split: 0, split_items: [],
            },
            // divided across the plan's targets - not a measurement
            Spidermites: {
              value: 2757.91, attributed: 0, split: 2757.91,
              split_items: ["CHE00058", "CHE00025"],
            },
            Nutrition: { value: 0, attributed: 0, split: 0, split_items: [] },
          },
          total: 12305.39,
        },
      ],
      target_totals: { "Downy Mildew": 9547.48, Spidermites: 2757.91, Nutrition: 0 },
      total: 12305.39,
    },
  ],
  unattributed: [
    { cost_center: "Production - MFK", kind: "foliar", value: 9326894.71 },
    { cost_center: "Production - MFK", kind: "chemical", value: 6020912.13 },
  ],
  untargeted_items: [
    {
      item_code: "FER00008", item_name: "CALCIUM NITRATE (Yara)",
      kind: "foliar", value: 1852398.57,
    },
  ],
};

vi.mock("@/lib/finance-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/finance-api")>()),
  fetchChemicalCostByTarget: vi.fn(async () => REPORT),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">menu</button>,
}));

const { Finance } = await import("@/pages/Finance");

describe("Finance page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a split figure so it cannot be read as measured", async () => {
    render(<Finance />);
    // Spidermites is 100% split across the plan's targets.
    await waitFor(() => expect(screen.getByText("~100%")).toBeInTheDocument());
  });

  it("does not mark a genuinely attributed figure", async () => {
    render(<Finance />);
    // 9,547 appears twice: the cell and its column total. Both unmarked.
    await waitFor(() => expect(screen.getAllByText(/9,547/).length).toBeGreaterThan(0));
    // Only one marker on the page — the attributed cell carries none.
    expect(screen.getAllByText(/^~\d+%$/)).toHaveLength(1);
  });

  it("explains that the totals changed meaning, not the data", async () => {
    render(<Finance />);
    await waitFor(() =>
      expect(
        screen.getByText(/now include product issued directly from the store/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/the definition\s+changed, not because the data did/i))
      .toBeInTheDocument();
  });

  it("reports store-issued spend as unattributed, with both kinds", async () => {
    render(<Finance />);
    await waitFor(() =>
      expect(screen.getByText("Unattributed spend")).toBeInTheDocument(),
    );
    expect(screen.getByText(/no greenhouse and no target/i)).toBeInTheDocument();
    expect(screen.getByText(/9,326,895/)).toBeInTheDocument();
    expect(screen.getByText(/6,020,912/)).toBeInTheDocument();
  });

  it("lists the products with no targets as an actionable backlog", async () => {
    render(<Finance />);
    await waitFor(() =>
      expect(
        screen.getByText("Products with no targets recorded"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("CALCIUM NITRATE (Yara)")).toBeInTheDocument();
    expect(screen.getByText("FER00008")).toBeInTheDocument();
  });

  it("names the untargeted products, not just their codes", async () => {
    const user = userEvent.setup();
    render(<Finance />);
    await waitFor(() => expect(screen.getByText("~100%")).toBeInTheDocument());
    await user.hover(screen.getByText("~100%"));
    await waitFor(() =>
      expect(screen.getAllByText("MAGNUM GOLD").length).toBeGreaterThan(0),
    );
    expect(screen.getAllByText("TECAMIN MAX").length).toBeGreaterThan(0);
  });

  it("pins the greenhouse column and scrolls the rest inside the table", async () => {
    render(<Finance />);
    await waitFor(() =>
      expect(screen.getByText("Main GH 04 - MFK")).toBeInTheDocument(),
    );
    const cell = screen.getByText("Main GH 04 - MFK");
    // The greenhouse column stays put while the target columns slide under it.
    expect(cell.className).toContain("sticky");
    expect(cell.className).toContain("left-0");
    // ...and the sideways scrolling happens inside the table, not on the page,
    // which is what stopped the sidebar being dragged along.
    const scroller = cell.closest("div.overflow-x-auto");
    expect(scroller).not.toBeNull();
  });

  it("shows chemical and foliar totals separately", async () => {
    render(<Finance />);
    // The grand total appears in the header and again in the unattributed card.
    await waitFor(() =>
      expect(screen.getAllByText(/20,964,894/).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/11,637,699/)).toBeInTheDocument();
    expect(screen.getByText(/9,327,195/)).toBeInTheDocument();
  });
});
