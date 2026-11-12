import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
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

describe("TreePicker single mode", () => {
  function Single({ onPick }: { onPick?: () => void }) {
    const [c, setC] = useState(new Set(["s:GH1"]));
    const tree: TreeNode[] = [{ id: "all", label: "All farms" }, ...nodes];
    return (
      <>
        <TreePickerPanel single nodes={tree} checked={c} onChange={setC} onPick={onPick} searchPlaceholder="Search farms" />
        <output data-testid="picked">{[...c].join(",")}</output>
      </>
    );
  }
  const radio = (name: string) => screen.getByRole("radio", { name });

  it("shows radio dots, no Select all and no count header", () => {
    render(<Single />);
    expect(radio("Chepsito GH 01")).toHaveAttribute("aria-checked", "true");
    expect(radio("Chepsito")).toHaveAttribute("aria-checked", "false"); // no half state
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Select every/ })).toBeNull();
  });

  it("a pick replaces the selection and reports it", () => {
    const onPick = vi.fn();
    render(<Single onPick={onPick} />);
    fireEvent.click(screen.getByText("Karen GH 01"));
    expect(screen.getByTestId("picked")).toHaveTextContent(/^s:K1$/);
    fireEvent.click(screen.getByText("Chepsito"));
    expect(screen.getByTestId("picked")).toHaveTextContent(/^f:Chepsito$/);
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("a non-selectable header only expands", () => {
    const tree: TreeNode[] = [{ id: "f:A", label: "Farm A", selectable: false, children: [{ id: "h:1", label: "A1" }] }];
    const onChange = vi.fn();
    render(<TreePickerPanel single nodes={tree} checked={new Set()} onChange={onChange} />);
    expect(screen.queryByRole("radio", { name: "Farm A" })).toBeNull();
    fireEvent.click(screen.getByText("Farm A"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("A1")).toBeNull(); // collapsed by the click
    fireEvent.click(screen.getByText("Farm A"));
    expect(screen.getByText("A1")).toBeTruthy();
  });

  it("Enter in search picks the best match", () => {
    render(<Single />);
    fireEvent.change(screen.getByPlaceholderText("Search farms"), { target: { value: "karen" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Search farms"), { key: "Enter" });
    expect(screen.getByTestId("picked")).toHaveTextContent(/^f:Karen$/);
  });
});

describe("TreePicker cascade mode", () => {
  function Casc() {
    const [c, setC] = useState(new Set<string>());
    return <TreePickerPanel cascade nodes={nodes} checked={c} onChange={setC} />;
  }
  it("a group follows its leaves and toggles them all; the count is leaves", () => {
    render(<Casc />);
    fireEvent.click(screen.getByText("Chepsito GH 01"));
    expect(dot("Chepsito")).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(screen.getByText("Chepsito"));
    expect(dot("Chepsito")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByText("Chepsito"));
    expect(screen.getByText("0 selected")).toBeTruthy();
  });
});
