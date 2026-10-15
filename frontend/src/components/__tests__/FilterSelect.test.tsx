import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterSelect } from "@/components/FilterSelect";

// Radix Select needs these in jsdom.
Object.assign(Element.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

describe("FilterSelect shape", () => {
  it("trigger is a pill, items and the selected item are rounded, not rectangles", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterSelect label="Farm" value="B" onChange={onChange} options={["A", "B"]} />);
    const trigger = screen.getByRole("combobox", { name: "Farm" });
    expect(trigger.className).toMatch(/rounded-full/);
    await user.click(trigger);
    const items = screen.getAllByRole("option");
    for (const it of items) expect(it.className).toMatch(/rounded-full/);
    const selected = screen.getByRole("option", { name: "B" });
    expect(selected.className).toMatch(/data-\[state=checked\]:bg-/);
    await user.click(screen.getByRole("option", { name: "A" }));
    expect(onChange).toHaveBeenCalledWith("A");
  });
});
