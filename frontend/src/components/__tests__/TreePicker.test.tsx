import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TreePickerPanel } from "@/components/TreePicker";
import type { TreeNode } from "@/pages/trends/trends-types";

const nodes: TreeNode[] = [
  { id: "f:Chepsito", label: "Chepsito", count: 10, children: [
    { id: "s:GH1", label: "Chepsito GH 01", count: 4 },
    { id: "s:GH2", label: "Chepsito GH 02", count: 6 },
  ] },
  { id: "f:Karen", label: "Karen", count: 3, children: [{ id: "s:K1", label: "Karen GH 01", count: 3 }] },
];

function Harness({ start = [] as string[] }) {
  const [c, setC] = useState(new Set(start));
  return <TreePickerPanel nodes={nodes} checked={c} onChange={setC} searchPlaceholder="Search farms" />;
}

const dot = (name: string) => screen.getByRole("checkbox", { name });

describe("TreePicker", () => {
  it("renders circular dots with unchecked / checked / mixed states", () => {
    render(<Harness start={["s:GH1"]} />);
    expect(dot("Chepsito GH 02")).toHaveAttribute("aria-checked", "false");
    expect(dot("Chepsito GH 01")).toHaveAttribute("aria-checked", "true");
    expect(dot("Chepsito")).toHaveAttribute("aria-checked", "mixed");
    expect(dot("Chepsito").className).toContain("rounded-full");
    expect(dot("Karen")).toHaveAttribute("aria-checked", "false");
  });

  it("toggles a row from its dot (click and keyboard-activated click)", () => {
    render(<Harness />);
    fireEvent.click(dot("Chepsito GH 02"));
    expect(dot("Chepsito GH 02")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(dot("Chepsito GH 02"));
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("has one Select all <-> Deselect all toggle", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText("3 selected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select all" })).toBeTruthy();
  });

  it("has one Expand all <-> Collapse all toggle", () => {
    render(<Harness />);
    expect(screen.getByText("Chepsito GH 01")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(screen.queryByText("Chepsito GH 01")).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByText("Chepsito GH 01")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeTruthy();
  });

  it("keeps the header to three items on one non-wrapping row", () => {
    render(<Harness />);
    const header = screen.getByTestId("tree-picker-header");
    expect(header.className).toContain("flex-nowrap");
    expect(header.children).toHaveLength(3);
    expect(header.textContent).toContain("0 selected");
  });

  it("filters by search, ignoring case and spaces, and clears", () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText("Search farms"), { target: { value: "gh 02" } });
    expect(screen.getByText("Chepsito GH 02")).toBeTruthy();
    expect(screen.queryByText("Chepsito GH 01")).toBeNull();
    expect(screen.queryByText("Karen")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Karen")).toBeTruthy();
  });

  it("group icons select and clear every child", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Select every greenhouse in Chepsito" }));
    expect(dot("Chepsito GH 01")).toHaveAttribute("aria-checked", "true");
    expect(dot("Chepsito GH 02")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Clear Chepsito" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
  });
});
