import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sparkline, seriesDelta } from "../Sparkline";
import { Kpi } from "../Kpi";

const pts = (vals: number[]) =>
  vals.map((value, i) => ({ week: `2026-W${String(30 + i).padStart(2, "0")}`, value }));

describe("Sparkline", () => {
  it("renders a line with one segment per point and an end dot", () => {
    const { container } = render(<Sparkline points={pts([1, 4, 2, 8, 5, 6, 3, 9])} />);
    const d = container.querySelector("path")!.getAttribute("d")!;
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/C/g)).toHaveLength(7); // smooth bezier, no fill
    expect(container.querySelector("path")!.getAttribute("fill")).toBe("none");
    expect(container.querySelector("linearGradient")).not.toBeNull();
    expect(screen.getByTestId("spark-dot")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-sparkline").dataset.muted).toBe("false");
  });

  it("is muted when there are fewer than 3 points", () => {
    render(<Sparkline points={pts([3, 5])} />);
    const el = screen.getByTestId("kpi-sparkline");
    expect(el.dataset.muted).toBe("true");
    expect(el.className).toContain("opacity-30");
  });

  it("renders nothing without a series", () => {
    const { container } = render(<Sparkline points={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the week and value on hover", () => {
    const { container } = render(<Sparkline points={pts([1, 2, 3, 4])} />);
    fireEvent.mouseMove(container.querySelector("svg")!, { clientX: 10_000 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("2026-W33: 4");
    fireEvent.mouseLeave(container.querySelector("svg")!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("sits in the top-right corner of a KPI card", () => {
    render(<Kpi label="Active Pests" value={12} series={pts([1, 2, 3, 4])} />);
    const el = screen.getByTestId("kpi-sparkline");
    expect(el.className).toContain("top-5");
    expect(el.className).toContain("right-4");
    expect(el.className).toContain("absolute");
  });

  it("a card without a series has no sparkline, and none while loading", () => {
    const { rerender } = render(<Kpi label="Top Pest" value="x" />);
    expect(screen.queryByTestId("kpi-sparkline")).toBeNull();
    rerender(<Kpi label="A" value={1} loading series={pts([1, 2, 3])} />);
    expect(screen.queryByTestId("kpi-sparkline")).toBeNull();
  });

  it("computes the week-on-week delta", () => {
    expect(seriesDelta(pts([5]))).toBeNull();
    expect(seriesDelta(pts([10, 12]))).toMatchObject({ dir: "up", pct: 20 });
    expect(seriesDelta(pts([10, 5]))).toMatchObject({ dir: "down", pct: -50 });
    expect(seriesDelta(pts([4, 4]))?.dir).toBe("flat");
    expect(seriesDelta(pts([0, 3]))?.pct).toBeNull();
  });

  it("shows a delta pill, tinted only when a good direction is given", () => {
    const { rerender } = render(<Kpi label="A" value={12} series={pts([1, 2, 3, 4])} />);
    const pill = screen.getByTestId("kpi-delta");
    expect(pill.dataset.dir).toBe("up");
    expect(pill).toHaveTextContent("33%");
    expect(pill.className).not.toContain("data-green");
    rerender(<Kpi label="A" value={12} series={pts([1, 2, 3, 4])} goodDirection="down" />);
    expect(screen.getByTestId("kpi-delta").className).toContain("data-red");
  });

  it("has no delta pill without two points", () => {
    render(<Kpi label="A" value={1} series={pts([3])} />);
    expect(screen.queryByTestId("kpi-delta")).toBeNull();
  });
});
