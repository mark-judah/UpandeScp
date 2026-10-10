import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VarietyTable } from "../VarietyTable";
import type { VarietyRow } from "@/lib/prevalence";

const ROWS: VarietyRow[] = [
  { variety: "Fuchsiana", beds: 6, scouted: 18, infested: 6, prevalence: 33.3, signs: 66.7, few: false },
  { variety: "Red Naomi", beds: 3, scouted: 9, infested: 3, prevalence: 33.3, signs: 66.7, few: true },
  { variety: "", beds: 1, scouted: 2, infested: 0, prevalence: 0, signs: 0, few: true },
];

describe("VarietyTable", () => {
  it("lists each variety with its beds, stations, live share and signs", () => {
    render(<VarietyTable rows={ROWS} pest="Thrips" />);
    expect(screen.getByText("By variety · Thrips")).toBeInTheDocument();
    const [first] = screen.getAllByTestId("variety-row");
    for (const text of ["Fuchsiana", "6", "18", "33.3%", "66.7%"]) {
      expect(within(first).getByText(text)).toBeInTheDocument();
    }
    expect(first).toHaveAttribute("data-few", "false");
  });

  it("greys the varieties with fewer than 10 stations scouted", () => {
    render(<VarietyTable rows={ROWS} />);
    const few = screen.getAllByTestId("variety-row")[1];
    expect(few).toHaveAttribute("data-few", "true");
    expect(few.className).toMatch(/opacity-60/);
    expect(within(few).getByText("too few")).toBeInTheDocument();
  });

  it("names stations on beds with no variety", () => {
    render(<VarietyTable rows={ROWS} />);
    expect(screen.getByText("No variety recorded")).toBeInTheDocument();
  });

  it("drops the signs column when the pest has no sign stage", () => {
    render(<VarietyTable rows={ROWS.map((r) => ({ ...r, signs: null }))} />);
    expect(screen.queryByText("Signs")).toBeNull();
  });

  it("is hidden without varieties (avocado, coffee) and draws no left-border strip", () => {
    const { container, rerender } = render(<VarietyTable rows={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VarietyTable rows={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<VarietyTable rows={ROWS} />);
    expect(container.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});
