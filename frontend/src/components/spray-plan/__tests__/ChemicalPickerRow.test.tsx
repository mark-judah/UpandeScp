import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChemicalPickerRow } from "../ChemicalPickerRow";
import { pickerState } from "@/lib/spray-compliance-api";

const item = { item_code: "CHEM-1", item_name: "Sulfur", stock_uom: "Litre" } as never;
const elig = { item: "CHEM-1", eligible: false, rules: ["target_match"], reasons: ["x"] } as never;

function row(showAll: boolean, onAdd = vi.fn(), onInactive = vi.fn()) {
  render(
    <ChemicalPickerRow item={item} state={pickerState(elig, showAll)} targetLabel="Botrytis"
      onAdd={onAdd} onInactive={onInactive} />,
  );
  return { onAdd, onInactive };
}

describe("ChemicalPickerRow", () => {
  it("renders an off-target product greyed, with a hint, and cannot add it", () => {
    const { onAdd, onInactive } = row(false);
    const b = screen.getByRole("button");
    expect(b).toHaveAttribute("aria-disabled", "true");
    expect(b.className).toContain("opacity-60");
    expect(screen.getByText("Not for Botrytis")).toBeInTheDocument();
    fireEvent.click(b);
    expect(onAdd).not.toHaveBeenCalled();
    expect(onInactive).toHaveBeenCalled();
  });
  it("activates it once Show all is ticked", () => {
    const { onAdd } = row(true);
    fireEvent.click(screen.getByRole("button"));
    expect(onAdd).toHaveBeenCalled();
  });
  it("leaves an on-target product normal", () => {
    const onAdd = vi.fn();
    render(<ChemicalPickerRow item={item} state={pickerState(undefined, false)} onAdd={onAdd} />);
    const b = screen.getByRole("button");
    expect(b).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(b);
    expect(onAdd).toHaveBeenCalled();
  });
});
