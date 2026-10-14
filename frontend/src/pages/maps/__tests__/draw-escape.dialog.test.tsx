import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { BedSvg } from "../BedSvg";
import { drawEscapeHandler, useDrawArea } from "../use-draw-area";
import type { ProjectedGeometry } from "../bed-projection";

const geometry: ProjectedGeometry = { viewBox: "0 0 100 100", width: 100, height: 100, beds: [], zoneCentroids: {} };

function Modal() {
  const [open, setOpen] = useState(true);
  const draw = useDrawArea(vi.fn());
  return (
    <>
      <span data-testid="open">{open ? "open" : "closed"}</span>
      <span data-testid="active">{draw.active ? "yes" : "no"}</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEscapeKeyDown={drawEscapeHandler(draw)}>
          <DialogTitle>House</DialogTitle>
          <DialogDescription>Latest week</DialogDescription>
          <button type="button" onClick={draw.start}>
            Draw area
          </button>
          <BedSvg
            geometry={geometry}
            markers={[]}
            draft={draw.active ? draw.vertices : null}
            onCanvasClick={draw.active ? draw.add : undefined}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

describe("Esc while drawing inside the heatmap modal", () => {
  it("cancels the draw and keeps the dialog open; a second Esc closes it", () => {
    render(<Modal />);
    fireEvent.click(screen.getByText("Draw area"));
    const svg = document.querySelector("svg")!;
    fireEvent.click(svg, { clientX: 1, clientY: 1 });
    expect(screen.getByTestId("draw-draft")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByTestId("active")).toHaveTextContent("no");
    expect(screen.getByTestId("open")).toHaveTextContent("open");
    expect(screen.queryByTestId("draw-draft")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByTestId("open")).toHaveTextContent("closed");
  });
});
