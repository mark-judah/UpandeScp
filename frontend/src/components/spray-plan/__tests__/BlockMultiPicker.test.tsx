import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BlockMultiPicker } from "@/components/spray-plan/BlockMultiPicker";
import type { OpenFieldBlock, OpenFieldGroup } from "@/lib/open-field";

const blk = (name: string, crop: string | null): OpenFieldBlock => ({
  name: `${name} - KL`,
  label: name,
  farm: "Lokitela",
  crop,
  crop_label: crop,
  area_ha: 1,
  cost_center: `${name} - KL`,
});

const pivot: OpenFieldGroup = {
  kind: "Section",
  name: "Section 1 - KL",
  label: "Section 1",
  blocks: Array.from({ length: 12 }, (_, i) => blk(`S1-B${i + 1}`, i % 2 ? "Avocado" : "Onion")),
};
const section: OpenFieldGroup = {
  kind: "Section",
  name: "Section A - KL",
  label: "Section A",
  blocks: [blk("Avocado Block A", "Avocado"), blk("Avocado Block B", "Avocado")],
};

function setup(selected: string[] = []) {
  const onChange = vi.fn();
  render(<BlockMultiPicker groups={[pivot, section]} selected={selected} onChange={onChange} />);
  return { onChange, user: userEvent.setup() };
}

describe("BlockMultiPicker", () => {
  it("lists every block of a 12-block pivot with its crop highlighted", () => {
    setup();
    expect(screen.getByText("S1-B12")).toBeInTheDocument();
    expect(screen.getAllByTestId("crop-chip").length).toBe(14);
    const row = screen.getByText("S1-B1").closest("[data-block]") as HTMLElement;
    expect(within(row).getByTestId("crop-chip")).toHaveTextContent("Onion");
  });

  it("picks a block", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("checkbox", { name: "S1-B3" }));
    expect(onChange).toHaveBeenCalledWith(["S1-B3 - KL"]);
  });

  it("select-all on a pivot picks all twelve", async () => {
    const { onChange, user } = setup();
    await user.click(screen.getByRole("checkbox", { name: "Select all of Section 1" }));
    expect(onChange.mock.calls[0][0]).toHaveLength(12);
  });

  it("filters by block or crop name", async () => {
    const { user } = setup();
    await user.type(screen.getByPlaceholderText(/search/i), "avocado");
    expect(screen.queryByText("S1-B1")).toBeNull();
    expect(screen.getByText("Avocado Block A")).toBeInTheDocument();
  });

  it("shows skeleton rows while loading", () => {
    render(<BlockMultiPicker groups={[]} selected={[]} onChange={() => {}} loading />);
    expect(document.querySelector("[data-skeleton='blocks']")).not.toBeNull();
  });
});
