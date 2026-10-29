import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SpendMatrix } from "../Finance";
import type { FinanceMatrix } from "@/lib/finance-api";

const matrix = {
  targets: ["Thrips", "Mildew"],
  rows: [
    { farm: "Mona", greenhouse: "GH 1", cells: { Thrips: { recorded: 100, derived: 0 }, Mildew: { recorded: 0, derived: 40 } }, recorded: 100, derived: 40, total: 140 },
    { farm: "Mona", greenhouse: "GH 2", cells: { Thrips: { recorded: 10, derived: 5 } }, recorded: 10, derived: 5, total: 15 },
  ],
  totals: { Thrips: { recorded: 110, derived: 5 }, Mildew: { recorded: 0, derived: 40 } },
  recorded: 110, derived: 45, total: 155,
} as FinanceMatrix;

describe("SpendMatrix", () => {
  it("colours actual and derived amounts apart, keeps a Total column and row, and has no inner scroll", () => {
    render(<SpendMatrix matrix={matrix} placeLabel="Greenhouse" />);
    const table = screen.getByTestId("spend-matrix");
    expect(within(table).getAllByText("Total").length).toBe(2); // column header + footer row
    const gh1 = within(table).getByText("GH 1").closest("tr")!;
    const cells = gh1.querySelectorAll("td");
    expect(cells[1].querySelector("span")!.className).toContain("text-emerald-700");
    expect(cells[2].querySelector("span")!.className).toContain("text-amber-600");
    expect(within(table).getByText(/^155/)).toBeTruthy();
    expect(table.closest("[class*='max-h']")).toBeNull();
  });
});
