import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MultiFilterSelect } from "@/components/MultiFilterSelect";

describe("MultiFilterSelect", () => {
  it("shows the empty label, then the picks", () => {
    const { rerender } = render(
      <MultiFilterSelect label="Pests" values={[]} onChange={() => {}} options={["A", "B", "C"]} allLabel="All pests" />,
    );
    expect(screen.getByLabelText("Pests")).toHaveTextContent("All pests");
    rerender(<MultiFilterSelect label="Pests" values={["A", "B"]} onChange={() => {}} options={["A", "B", "C"]} />);
    expect(screen.getByLabelText("Pests")).toHaveTextContent("A, B");
    rerender(<MultiFilterSelect label="Pests" values={["A", "B", "C"]} onChange={() => {}} options={["A", "B", "C"]} />);
    expect(screen.getByLabelText("Pests")).toHaveTextContent("3 selected");
  });

  it("toggles several options", async () => {
    const onChange = vi.fn();
    render(<MultiFilterSelect label="Pests" values={["A"]} onChange={onChange} options={["A", "B"]} />);
    await userEvent.click(screen.getByLabelText("Pests"));
    await userEvent.click(screen.getByText("B"));
    expect(onChange).toHaveBeenCalledWith(["A", "B"]);
    await userEvent.click(screen.getAllByText("A").slice(-1)[0]);
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("is not a native select", () => {
    const { container } = render(<MultiFilterSelect label="Pests" values={[]} onChange={() => {}} options={["A"]} />);
    expect(container.querySelector("select")).toBeNull();
  });
});
