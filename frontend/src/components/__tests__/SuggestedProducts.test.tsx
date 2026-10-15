import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestedProductsCard } from "@/components/spray-plan/SuggestedProducts";
import type { SuggestedProduct } from "@/lib/spray-compliance-api";

const suggest = vi.fn();
vi.mock("@/lib/spray-compliance-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-compliance-api")>()),
  suggestProducts: (...a: unknown[]) => suggest(...a),
}));

const product = (over: Partial<SuggestedProduct> = {}): SuggestedProduct => ({
  item_code: "P1", item_name: "Folicur", stock_uom: "Litre", item_group: "Fungicides",
  is_fertilizer: false, default_rate: 1.5, score: 82, dots: 5, eligible: true, worst_mode: "Off",
  warnings: [], covered_targets: ["Botrytis"], last_used_days: 21, usable_batches: 2, batch_tracked: true,
  free_qty: 10, cost_per_ha: 120, reason: "covers 1 of 1 target · last used 21 days ago · in stock, 2 usable batches",
  ...over,
});
const base = { targets: ["Botrytis"], greenhouses: ["GH 1"], sourceWarehouse: "Store A", currentItems: [] as string[] };

describe("SuggestedProductsCard", () => {
  beforeEach(() => suggest.mockReset());

  it("asks for targets before it suggests anything", () => {
    render(<SuggestedProductsCard {...base} targets={[]} onAdd={() => {}} />);
    expect(screen.getByText(/Pick targets/)).toBeTruthy();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("shows the rating and the one-line reason, and a tap adds the product", async () => {
    suggest.mockResolvedValue({ suggestions: [product()], considered: 1, unavailable: 0, blocked: 0, needs: null });
    const onAdd = vi.fn();
    render(<SuggestedProductsCard {...base} onAdd={onAdd} />);
    const row = await screen.findByTestId("suggest-P1");
    expect(screen.getByLabelText("Rating 5 of 5")).toBeTruthy();
    expect(row.textContent).toContain("covers 1 of 1 target");
    expect(row.textContent).toContain("1.5 / 1000 L");
    fireEvent.click(row);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ item_code: "P1", default_rate: 1.5 }));
  });

  it("shows a warned product with its warning", async () => {
    suggest.mockResolvedValue({
      suggestions: [product({ item_code: "P2", eligible: false, worst_mode: "Warn", dots: 2, warnings: ["Same FRAC 7 as Bravo"] })],
      considered: 1, unavailable: 0, blocked: 0, needs: null,
    });
    render(<SuggestedProductsCard {...base} onAdd={() => {}} />);
    await waitFor(() => expect(screen.getByText("Same FRAC 7 as Bravo")).toBeTruthy());
  });

  it("cannot add until a tank mix is chosen", async () => {
    suggest.mockResolvedValue({ suggestions: [product()], considered: 1, unavailable: 0, blocked: 0, needs: null });
    const onAdd = vi.fn();
    render(<SuggestedProductsCard {...base} canAdd={false} onAdd={onAdd} />);
    const row = await screen.findByTestId("suggest-P1");
    fireEvent.click(row);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
