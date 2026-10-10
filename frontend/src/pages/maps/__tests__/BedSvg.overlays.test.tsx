import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BedSvg } from "../BedSvg";
import { closeVertices, useDrawArea } from "../use-draw-area";
import type { ProjectedGeometry } from "../bed-projection";
import type { Pt } from "@/lib/hull";

const geometry: ProjectedGeometry = {
  viewBox: "0 0 100 100",
  width: 100,
  height: 100,
  beds: [],
  zoneCentroids: { Z1: { cx: 10, cy: 10 }, Z2: { cx: 30, cy: 10 }, Z3: { cx: 20, cy: 30 }, Z4: { cx: 20, cy: 15 } },
};

function Harness({ onFinish }: { onFinish: (ring: Pt[]) => void }) {
  const draw = useDrawArea(onFinish);
  return (
    <>
      <button type="button" onClick={draw.start}>
        Draw area
      </button>
      <BedSvg
        geometry={geometry}
        markers={[]}
        draft={draw.active ? draw.vertices : null}
        onCanvasClick={draw.active ? draw.add : undefined}
        onCanvasDoubleClick={draw.active ? draw.finish : undefined}
      />
      <span data-testid="active">{draw.active ? "yes" : "no"}</span>
    </>
  );
}

describe("BedSvg overlays", () => {
  it("outlines a patch as the hull of its zones, stroke only", () => {
    render(
      <BedSvg
        geometry={geometry}
        markers={[]}
        overlays={[
          { id: "patch-P1", zones: ["Z1", "Z2", "Z3", "Z4"], tone: "patch", label: "4 zones" },
          { id: "pin-A", points: [[50, 50], [60, 50], [55, 60]], tone: "pin", label: "my area" },
          { id: "patch-none", zones: ["missing"], tone: "patch" },
        ]}
      />,
    );
    const patch = screen.getByTestId("overlay-patch-P1");
    expect(patch.getAttribute("d")).toBe("M10 10 L30 10 L20 30 Z");        // Z4 lies inside the hull
    expect(patch.getAttribute("fill")).toBe("none");
    expect(screen.getByTestId("overlay-pin-A").getAttribute("stroke-dasharray")).toBeTruthy();
    expect(screen.queryByTestId("overlay-patch-none")).toBeNull();
  });

  it("draws the draft and reports clicks in SVG space", () => {
    const onClick = vi.fn();
    const onDbl = vi.fn();
    render(<BedSvg geometry={geometry} markers={[]} draft={[[1, 2], [3, 4]]} onCanvasClick={onClick} onCanvasDoubleClick={onDbl} />);
    expect(screen.getByTestId("draw-draft")).toHaveAttribute("data-vertices", "2");
    const svg = document.querySelector("svg")!;
    fireEvent.click(svg, { clientX: 12, clientY: 34 });
    expect(onClick).toHaveBeenCalledWith([12, 34]);
    fireEvent.doubleClick(svg);
    expect(onDbl).toHaveBeenCalledTimes(1);
  });
});

describe("drawing an area", () => {
  it("adds a corner per click and closes on double-click", () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} />);
    fireEvent.click(screen.getByText("Draw area"));
    const svg = document.querySelector("svg")!;
    for (const [x, y] of [[0, 0], [10, 0], [10, 10]]) fireEvent.click(svg, { clientX: x, clientY: y });
    expect(screen.getByTestId("draw-draft")).toHaveAttribute("data-vertices", "3");
    fireEvent.click(svg, { clientX: 10, clientY: 10 });                   // the double-click's own click
    fireEvent.doubleClick(svg, { clientX: 10, clientY: 10 });
    expect(onFinish).toHaveBeenCalledWith([[0, 0], [10, 0], [10, 10]]);
    expect(screen.getByTestId("active")).toHaveTextContent("no");
  });

  it("keeps drawing below three corners, and Esc cancels", () => {
    const onFinish = vi.fn();
    render(<Harness onFinish={onFinish} />);
    fireEvent.click(screen.getByText("Draw area"));
    const svg = document.querySelector("svg")!;
    fireEvent.click(svg, { clientX: 0, clientY: 0 });
    fireEvent.click(svg, { clientX: 5, clientY: 0 });
    fireEvent.doubleClick(svg);
    expect(onFinish).not.toHaveBeenCalled();
    expect(screen.getByTestId("active")).toHaveTextContent("yes");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("active")).toHaveTextContent("no");
    expect(screen.queryByTestId("draw-draft")).toBeNull();
  });

  it("closeVertices drops repeats and a closing corner", () => {
    expect(closeVertices([[0, 0], [1, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});
