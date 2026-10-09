import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useDashboardAggregate = vi.fn();
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));

import { SectionGrid } from "../SectionGrid";
import { GreenhouseModal } from "../GreenhouseModal";
import type { SectionCell } from "@/lib/prevalence";

function cells(pct: (r: number, c: number) => number | null): SectionCell[] {
  const out: SectionCell[] = [];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const p = pct(r, c);
      out.push({ row: r, col: c, scouted: p == null ? 2 : 3, infested: p == null ? 0 : 1, pct: p });
    }
  return out;
}

describe("SectionGrid", () => {
  it("shows each section's % and greys the ones below 3 scouted stations", () => {
    render(<SectionGrid sections={cells((r, c) => (r === 2 && c === 2 ? null : 33.3))} />);
    expect(screen.getByTestId("section-0-0")).toHaveTextContent("33.3%");
    expect(screen.getByTestId("section-0-0")).toHaveAttribute("data-scouted", "true");
    const corner = screen.getByTestId("section-2-2");
    expect(corner).toHaveTextContent("not scouted");
    expect(corner).toHaveAttribute("data-scouted", "false");
    expect(screen.getByText("Front")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
  });
});

describe("GreenhouseModal 3 × 3", () => {
  beforeEach(() => {
    const figure = { margin: 17.8, sections_scouted: 9, sections_total: 9, reliability: "Fair" as const, reason: null, prev: null };
    useDashboardAggregate.mockReset().mockReturnValue({
      data: {
        topPests: [{ name: "Thrips", count: 9 }],
        topDiseases: [{ name: "Downy Mildew", count: 3 }],
        traps: [], daily: [], scouts: 1, alerts: 0,
        prevalence: [
          { kind: "pest", name: "Thrips", prevalence: 33.3, ...figure, sections: cells(() => 33.3) },
          { kind: "disease", name: "Downy Mildew", prevalence: 11.1, ...figure,
            sections: cells((r, c) => (r === 0 && c === 0 ? 100 : 0)) },
        ],
      },
    });
  });

  it("maps the top observation first and switches on click", () => {
    render(<GreenhouseModal greenhouse="Chepsito GH 01 - KR" fromDate="2031-03-03" toDate="2031-03-09" crop="Rose" onClose={() => {}} />);
    expect(screen.getByTestId("section-1-1")).toHaveTextContent("33.3%");
    expect(screen.getByText("33.3% · ±17.8 · 9/9")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Downy Mildew" }));
    expect(screen.getByTestId("section-0-0")).toHaveTextContent("100%");
    expect(screen.getByTestId("section-1-1")).toHaveTextContent("0%");
  });
});
