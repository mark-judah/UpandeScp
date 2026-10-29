import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchSelect, filterOptions } from "../SearchSelect";

const options = [
  { value: "Chemical Store - MUT", label: "Chemical Store - MUT", hint: "Mutara" },
  { value: "Fertilizer Store - MUT", label: "Fertilizer Store - MUT", hint: "Mutara" },
  { value: "Main Store - MO", label: "Main Store - MO" },
];

describe("SearchSelect", () => {
  it("filters by everything typed, not one letter", () => {
    expect(filterOptions(options, "fert").map((o) => o.value)).toEqual(["Fertilizer Store - MUT"]);
    expect(filterOptions(options, "store mut").length).toBe(2);
  });
  it("types a whole word in the box and picks the match", () => {
    const onChange = vi.fn();
    render(<SearchSelect value={null} options={options} onChange={onChange} ariaLabel="Chemical store" />);
    fireEvent.click(screen.getByRole("button", { name: "Chemical store" }));
    const box = screen.getByPlaceholderText("Type to search…");
    fireEvent.change(box, { target: { value: "chem" } });
    expect((box as HTMLInputElement).value).toBe("chem");
    fireEvent.click(screen.getByRole("option", { name: /Chemical Store - MUT/ }));
    expect(onChange).toHaveBeenCalledWith("Chemical Store - MUT");
  });
});
