import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SuggestedProductsCard } from "@/components/spray-plan/SuggestedProducts";
import type { SuggestedProduct } from "@/lib/spray-compliance-api";

const suggest = vi.fn();
const suggestMix = vi.fn();
vi.mock("@/lib/spray-compliance-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-compliance-api")>()),
  suggestProducts: (...a: unknown[]) => suggest(...a),
  suggestMix: (...a: unknown[]) => suggestMix(...a),
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
  beforeEach(() => {
    suggest.mockReset();
    suggestMix.mockReset();
  });

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

  it("highlights each suggestion with a Suggested pill and shows the targets it is for, uncovered ones muted", async () => {
    suggest.mockResolvedValue({
      suggestions: [product({ covered_targets: ["Thrips"], uncovered_targets: ["Spidermites"] })],
      considered: 1, unavailable: 0, blocked: 0, needs: null,
    });
    render(<SuggestedProductsCard {...base} targets={["Thrips", "Spidermites"]} onAdd={() => {}} />);
    const row = await screen.findByTestId("suggest-P1");
    expect(row.className).toContain("bg-primary/5");
    expect(row.querySelector('[data-testid="suggested-pill"]')).toBeTruthy();
    expect(row.querySelector('[data-testid="target-covered"]')?.textContent).toBe("Thrips");
    expect(row.querySelector('[data-testid="target-uncovered"]')?.textContent).toBe("Spidermites");
  });

  it("reports the suggested item codes so the picker can mark them", async () => {
    suggest.mockResolvedValue({ suggestions: [product()], considered: 1, unavailable: 0, blocked: 0, needs: null });
    const onSuggested = vi.fn();
    render(<SuggestedProductsCard {...base} onAdd={() => {}} onSuggested={onSuggested} />);
    await screen.findByTestId("suggest-P1");
    expect(onSuggested).toHaveBeenLastCalledWith(["P1"]);
  });

  it("says which targets the mix already covers and lists only suggestions for the rest", async () => {
    suggest.mockResolvedValue({
      suggestions: [product({ item_code: "P9", item_name: "Mitac", covered_targets: ["Spidermites"] })],
      considered: 1, unavailable: 0, blocked: 0, needs: null,
      covered: [{ target: "Thrips", items: ["P1"], products: ["Folicur"] }],
      remaining_targets: ["Spidermites"], all_covered: false,
    });
    render(
      <SuggestedProductsCard {...base} targets={["Thrips", "Spidermites"]} currentItems={["P1"]} onAdd={() => {}} />,
    );
    await screen.findByTestId("suggest-P9");
    expect(screen.getByTestId("covered-targets").textContent).toContain("Thrips covered by Folicur");
    expect(screen.queryByTestId("suggest-P1")).toBeNull();
  });

  it("recomputes when a row is added or removed", async () => {
    suggest.mockResolvedValue({ suggestions: [product()], considered: 1, unavailable: 0, blocked: 0, needs: null });
    const { rerender } = render(<SuggestedProductsCard {...base} onAdd={() => {}} />);
    await screen.findByTestId("suggest-P1");
    rerender(<SuggestedProductsCard {...base} currentItems={["P1"]} onAdd={() => {}} />);
    await waitFor(() => expect(suggest).toHaveBeenCalledTimes(2));
    expect(suggest.mock.calls[1][0]).toMatchObject({ currentItems: ["P1"] });
  });

  it("says so when every target is covered", async () => {
    suggest.mockResolvedValue({
      suggestions: [], considered: 0, unavailable: 0, blocked: 0, needs: null,
      covered: [{ target: "Botrytis", items: ["P1"], products: ["Folicur"] }], remaining_targets: [], all_covered: true,
    });
    render(<SuggestedProductsCard {...base} currentItems={["P1"]} onAdd={() => {}} />);
    await screen.findByTestId("all-covered");
  });

  describe("suggested tank mix", () => {
    const mix = {
      mixes: [
        {
          products: [
            product({ item_code: "P1", item_name: "Folicur", codes: ["FRAC 3"] }),
            product({ item_code: "P2", item_name: "Mitac", codes: ["IRAC 19"] }),
          ].map((p, i) => ({ ...p, covers: [["Botrytis"], ["Thrips"]][i] })),
          covers: { Botrytis: ["Folicur"], Thrips: ["Mitac"] }, codes: ["FRAC 3", "IRAC 19"], score: 70, size: 2,
        },
      ],
      needs: null, targets: ["Botrytis", "Thrips"], replaces: [],
    };
    const open = async (props: Record<string, unknown>) => {
      suggest.mockResolvedValue({ suggestions: [product()], considered: 1, unavailable: 0, blocked: 0, needs: null });
      suggestMix.mockResolvedValue(mix);
      render(<SuggestedProductsCard {...base} targets={["Botrytis", "Thrips"]} onAdd={() => {}} {...props} />);
      await screen.findByTestId("suggest-P1");
      fireEvent.click(screen.getByTestId("suggest-mix-toggle"));
      await screen.findByTestId("mix-0");
    };

    it("shows each option's products, the targets each covers and the MoA groups", async () => {
      await open({ onAddMix: () => {} });
      const m = screen.getByTestId("mix-0");
      expect(m.textContent).toContain("2 products");
      expect(m.textContent).toContain("FRAC 3");
      expect(m.textContent).toContain("IRAC 19");
      expect(m.textContent).toContain("Thrips");
    });

    it("adds the whole mix in one tap when the tank mix is empty", async () => {
      const onAddMix = vi.fn();
      await open({ onAddMix });
      fireEvent.click(screen.getByTestId("mix-add-0"));
      expect(onAddMix).toHaveBeenCalledWith([expect.objectContaining({ item_code: "P1" }), expect.objectContaining({ item_code: "P2" })]);
    });

    it("asks before replacing existing rows", async () => {
      const onAddMix = vi.fn();
      await open({ onAddMix, currentItems: ["X"] });
      fireEvent.click(screen.getByTestId("mix-add-0"));
      expect(onAddMix).not.toHaveBeenCalled();
      expect(screen.getByTestId("mix-confirm").textContent).toContain("Replace the 1 chemical already");
      fireEvent.click(screen.getByText("Cancel"));
      expect(screen.queryByTestId("mix-confirm")).toBeNull();
      fireEvent.click(screen.getByTestId("mix-add-0"));
      fireEvent.click(screen.getByText("Replace"));
      expect(onAddMix).toHaveBeenCalledTimes(1);
    });
  });
});
