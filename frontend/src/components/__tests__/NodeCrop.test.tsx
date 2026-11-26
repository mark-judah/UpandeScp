import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CropBadge, NodeCropEditor } from "../NodeCrop";
import { cropPill } from "@/lib/structure-tree";

import type { NodeCrop } from "@/lib/structure-api";
const none: NodeCrop = { own: null, inherited: null, inherited_from: null, cycle: null };

describe("cropPill", () => {
  it("own, inherited, cycle override, none", () => {
    expect(cropPill({ ...none, own: "Avocado" })).toEqual({ text: "Avocado", tone: "own" });
    expect(cropPill({ ...none, inherited: "Avocado", inherited_from: "Pivot 3" }).text).toBe("Avocado · from Pivot 3");
    expect(cropPill({ ...none, own: "Avocado", cycle: "Potato" })).toEqual({ text: "Potato · crop cycle", tone: "cycle" });
    expect(cropPill(none).tone).toBe("none");
  });
});

describe("CropBadge", () => {
  const draw = (crop: NodeCrop, editable: boolean, onEdit = vi.fn()) => {
    render(<svg><CropBadge crop={crop} x={0} y={0} maxWidth={200} editable={editable} onEdit={onEdit} /></svg>);
    return onEdit;
  };
  it("shows an inherited crop muted with its source", () => {
    draw({ ...none, inherited: "Avocado", inherited_from: "Pivot 3" }, false);
    expect(screen.getByTestId("crop-badge").getAttribute("data-tone")).toBe("inherited");
    expect(screen.getByText("Avocado · from Pivot 3")).toBeTruthy();
  });
  it("renders nothing for a read-only node without a crop", () => {
    draw(none, false);
    expect(screen.queryByTestId("crop-badge")).toBeNull();
  });
  it("lets an editor click a pill and offers Set crop on empty nodes", () => {
    const edit = draw(none, true);
    fireEvent.click(screen.getByText("Set crop"));
    expect(edit).toHaveBeenCalled();
  });
});

describe("NodeCropEditor", () => {
  it("picks a crop from the searchable list and saves it", () => {
    const save = vi.fn();
    render(<NodeCropEditor label="Pivot 3" current={null} crops={["Avocado", "Potato"]} onSave={save} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Crop"));
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "pot" } });
    expect(screen.queryByText("Avocado")).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Potato/ }));
    fireEvent.click(screen.getByText("Save"));
    expect(save).toHaveBeenCalledWith("Potato");
  });
  it("clears an existing crop", () => {
    const save = vi.fn();
    render(<NodeCropEditor label="Pivot 3" current="Avocado" crops={["Avocado"]} onSave={save} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Clear crop"));
    expect(save).toHaveBeenCalledWith(null);
  });
});
