import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IncidenceTooltip } from "../ChartPanel";
import type { PrevalencePoint } from "../aggregate";

function tip(point: PrevalencePoint) {
  render(
    <IncidenceTooltip
      active
      label="2031-W44"
      payload={[{ name: "GH 12", dataKey: "GH 12", value: 33.3, color: "#000" }]}
      statsByWeek={new Map()}
      unitLabelPlural="zones"
      prevalenceByWeek={new Map([["2031-W44", new Map([["GH 12", point]])]])}
    />,
  );
}

const point: PrevalencePoint = { prevalence: 33.3, margin: 17.8, reliability: "Fair", lo: 15.5, hi: 51.1 };

describe("Trends band tooltip", () => {
  it("shows the signs beside the adjusted prevalence", () => {
    tip({ ...point, signs: 66.7 });
    expect(screen.getByText(/adjusted prevalence ±17.8/)).toHaveTextContent("· Fair · signs 66.7%");
  });

  it("omits the signs when there are none", () => {
    tip({ ...point, signs: null });
    expect(screen.getByText(/adjusted prevalence ±17.8/).textContent).not.toMatch(/signs/);
  });
});
