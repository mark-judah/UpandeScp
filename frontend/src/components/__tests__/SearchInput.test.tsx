import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SearchInput } from "@/components/SearchInput";

function Harness({ initial = "" }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <SearchInput value={v} onChange={setV} placeholder="Search farms" />;
}

describe("SearchInput", () => {
  it("shows the clear button only with text, and clears and refocuses", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("Search farms") as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.change(input, { target: { value: "chep" } });
    expect(input.value).toBe("chep");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });

  it("uses the 8px rounded-rectangle standard", () => {
    render(<Harness />);
    expect(screen.getByPlaceholderText("Search farms").className).toContain("rounded-lg");
  });
});
