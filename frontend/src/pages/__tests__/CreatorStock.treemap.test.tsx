import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { freshnessBand } from "@/lib/stock-freshness";
import { squarify } from "@/lib/treemap";

const data = {
  farms: ["Karen"],
  low_stock_count: 1,
  aged_csu_count: 1,
  csu_max_age_days: 5,
  as_of: "2026-10-15T10:00:00",
  batches: {
    A: [{ batch: "A-1", qty: 5, expiry_date: "2026-10-25", days_to_expiry: 10 }],
    B: [{ batch: "B-1", qty: 5, expiry_date: "2026-12-30", days_to_expiry: 76 }],
  },
  chemical_stores: [
    {
      warehouse: "Chemical Store 1", farm: "Karen", total_qty: 40,
      items: [
        { item_code: "A", item_name: "Alpha", group: "g", uom: "Litre", qty: 5, value: 500, threshold: 10, low: true, oldest_age_days: 20, cohorts: [] },
        { item_code: "B", item_name: "Bravo", group: "g", uom: "Kg", qty: 20, value: 300, threshold: 0, low: false, oldest_age_days: 10, cohorts: [] },
        { item_code: "C", item_name: "Charlie", group: "g", uom: "Kg", qty: 15, value: 200, threshold: 0, low: false, oldest_age_days: 5, cohorts: [] },
        { item_code: "D", item_name: "Delta", group: "g", uom: "Kg", qty: 3, value: 0, threshold: 0, low: false, oldest_age_days: 5, cohorts: [] },
      ],
    },
  ],
  csus: [
    {
      warehouse: "Karen CSU 1", farm: "Karen", total_qty: 4, aged_count: 1,
      items: [{ item_code: "A", item_name: "Alpha", group: "g", uom: "Litre", qty: 4, value: 0, threshold: 0, aged: true, expired_qty: 4, fresh_qty: 0, oldest_age_days: 8, cohorts: [] }],
    },
  ],
};
vi.mock("@/lib/spray-plan-creator-api", () => ({ fetchCreatorStockOverview: () => Promise.resolve(data) }));
vi.mock("@/components/PlacePicker", () => ({ PlacePicker: () => <div>place pill</div> }));

const { CreatorStock } = await import("@/pages/CreatorStock");

describe("freshness band mapping", () => {
  it("maps expiry and shelf age to bands", () => {
    expect(freshnessBand({ daysToExpiry: -1, oldestAgeDays: 0 })).toBe("expired");
    expect(freshnessBand({ daysToExpiry: 10, oldestAgeDays: 0 })).toBe("near");
    expect(freshnessBand({ daysToExpiry: 76, oldestAgeDays: 0 })).toBe("ageing");
    expect(freshnessBand({ daysToExpiry: null, oldestAgeDays: 200 })).toBe("ageing");
    expect(freshnessBand({ daysToExpiry: 400, oldestAgeDays: 20 })).toBe("fresh");
    expect(freshnessBand({ daysToExpiry: null, oldestAgeDays: 20 })).toBe("fresh");
  });
});

describe("squarify", () => {
  it("tiles the box exactly, area proportional to value", () => {
    const r = squarify([{ id: "a", value: 6 }, { id: "b", value: 3 }, { id: "c", value: 1 }], { x: 0, y: 0, w: 100, h: 50 });
    expect(r).toHaveLength(3);
    expect(r.reduce((s, t) => s + t.w * t.h, 0)).toBeCloseTo(5000);
    const a = r.find((t) => t.id === "a")!;
    expect(a.w * a.h).toBeCloseTo(3000);
  });
});

describe("Chemical Stock page", () => {
  it("opens on CSU with the treemap, legend and no search; tabs are CSU then Available stock", async () => {
    render(<CreatorStock />);
    await waitFor(() => expect(screen.getAllByTestId("stock-tile").length).toBe(3));
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["CSU", "Available stock"]);
    expect(screen.getByRole("tab", { name: "CSU" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("searchbox")).toBeNull();
    const bands = Object.fromEntries(screen.getAllByTestId("stock-tile").map((t) => [t.getAttribute("data-code"), t.getAttribute("data-band")]));
    expect(bands).toEqual({ A: "near", B: "ageing", C: "fresh" });
    const legend = screen.getByTestId("freshness-legend");
    for (const l of ["Fresh", "Ageing", "Near expiry", "Expired"]) expect(within(legend).getByText(l)).toBeInTheDocument();
    expect(screen.queryByText("Alerts")).toBeNull();
  });

  it("puts refresh in the toolbar row, and the alerts filter only on Available stock", async () => {
    const user = userEvent.setup();
    render(<CreatorStock />);
    await waitFor(() => screen.getAllByTestId("stock-tile"));
    const bar = screen.getByTestId("page-toolbar");
    expect(within(bar).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(within(bar).queryByTitle(/only alerts/i)).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Available stock" }));
    expect(within(screen.getByTestId("page-toolbar")).getByTitle(/only alerts/i)).toBeInTheDocument();
  });

  it("click pins the summary, click again or Esc unpins", async () => {
    const user = userEvent.setup();
    render(<CreatorStock />);
    await waitFor(() => screen.getAllByTestId("stock-tile"));
    expect(screen.getByTestId("count-near")).toHaveTextContent("1");
    expect(screen.getByText(/1 chemical in stock with no valuation/)).toBeInTheDocument();
    const tile = () => screen.getAllByTestId("stock-tile").find((t) => t.getAttribute("data-code") === "A")!;
    await user.click(tile());
    const panel = screen.getByTestId("stock-summary");
    expect(within(panel).getByText("Alpha")).toBeInTheDocument();
    expect(within(panel).getByText("Chemical Store 1")).toBeInTheDocument();
    expect(within(panel).getByText("Karen CSU 1")).toBeInTheDocument();
    expect(within(panel).getByText("A-1")).toBeInTheDocument();
    expect(within(panel).getByTestId("summary-total")).toHaveTextContent("5");
    expect(tile()).toHaveAttribute("aria-pressed", "true");
    await user.click(tile());
    expect(screen.getByTestId("count-near")).toBeInTheDocument();
    await user.click(tile());
    expect(screen.getByTestId("summary-total")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("summary-total")).toBeNull();
    expect(screen.getByTestId("count-near")).toBeInTheDocument();
  });

  it("keyboard Enter pins a tile", async () => {
    const user = userEvent.setup();
    render(<CreatorStock />);
    await waitFor(() => screen.getAllByTestId("stock-tile"));
    screen.getAllByTestId("stock-tile")[0].focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("summary-total")).toBeInTheDocument();
  });

  it("hover shows a tooltip but does not change the summary panel; panel has a fixed height", async () => {
    render(<CreatorStock />);
    await waitFor(() => screen.getAllByTestId("stock-tile"));
    const panel = screen.getByTestId("stock-summary");
    expect(panel.className).toContain("h-[480px]");
    expect(panel.className).toContain("overflow-y-auto");
    fireEvent.mouseEnter(screen.getAllByTestId("stock-tile")[0], { clientX: 5, clientY: 5 });
    expect(screen.getByTestId("stock-tooltip")).toBeInTheDocument();
    expect(screen.getByTestId("count-near")).toBeInTheDocument();
    expect(screen.queryByTestId("summary-total")).toBeNull();
    expect(screen.getByTestId("stock-treemap")).toHaveStyle({ height: "480px" });
  });

  it("keeps the short notifications under Available stock", async () => {
    const user = userEvent.setup();
    render(<CreatorStock />);
    await waitFor(() => screen.getAllByTestId("stock-tile"));
    await user.click(screen.getByRole("tab", { name: "Available stock" }));
    expect(await screen.findByText("Alerts")).toBeInTheDocument();
    expect(screen.getByText("Chemical store health")).toBeInTheDocument();
    expect(screen.getByText(/CSUs . mixing units/)).toBeInTheDocument();
  });
});
