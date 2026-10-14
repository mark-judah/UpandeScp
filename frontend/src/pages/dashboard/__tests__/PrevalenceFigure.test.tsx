import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#000", disease: () => "#000" }),
}));
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: () => ({ data: null, loading: false, error: null, progress: null, reload: vi.fn() }),
}));

import { PrevalenceFigure } from "../PrevalenceFigure";
import { PestsTab } from "../PestsTab";
import { OverviewTab } from "../OverviewTab";
import type { PestsPayload } from "../pests-diseases-types";
import type { OverviewPayload } from "../overview-types";

const fig = {
  prevalence: 33.3, prev: 50, margin: 6, sections_scouted: 8, sections_total: 9,
  reliability: "Fair" as const, reason: null,
};

describe("PrevalenceFigure", () => {
  it("renders the figure line and the reliability pill", () => {
    render(<PrevalenceFigure fig={fig} />);
    expect(screen.getByText("33.3% (was 50%) · ±6 · 8/9")).toBeInTheDocument();
    expect(screen.getByTestId("reliability-pill")).toHaveTextContent("Fair");
    expect(screen.getByTestId("prevalence-figure").getAttribute("title")?.split("\n")).toHaveLength(4);
  });

  it("shows too clustered to judge with a Low pill", () => {
    render(<PrevalenceFigure fig={{ ...fig, margin: null, reason: "too clustered to judge", sections_scouted: 1, reliability: "Low" }} />);
    expect(screen.getByText("33.3% (was 50%) · too clustered to judge · 1/9")).toBeInTheDocument();
    expect(screen.getByTestId("reliability-pill")).toHaveTextContent("Low");
  });

  it("shows the share of houses per reliability for a scope-wide figure", () => {
    render(<PrevalenceFigure fig={{ ...fig, reliability: "Low", houses: 95, reliability_mix: { Good: 64, Fair: 28, Low: 3 } }} />);
    expect(screen.getByTestId("reliability-mix")).toHaveTextContent("Good 64 · Fair 28 · Low 3");
    expect(screen.queryByTestId("reliability-pill")).toBeNull();
    expect(screen.getByTestId("prevalence-figure").getAttribute("title")).toMatch(/Good 64 · Fair 28 · Low 3/);
  });

  it("hides empty ratings in the share and keeps the pill for one house", () => {
    const { unmount } = render(<PrevalenceFigure fig={{ ...fig, houses: 2, reliability_mix: { Good: 2, Fair: 0, Low: 0 } }} />);
    expect(screen.getByTestId("reliability-mix")).toHaveTextContent("Good 2");
    expect(screen.getByTestId("reliability-mix")).not.toHaveTextContent("Fair");
    unmount();
    render(<PrevalenceFigure fig={{ ...fig, houses: 1, reliability_mix: { Good: 0, Fair: 1, Low: 0 } }} />);
    expect(screen.getByTestId("reliability-pill")).toHaveTextContent("Fair");
    expect(screen.queryByTestId("reliability-mix")).toBeNull();
  });

  it("uses no coloured left border", () => {
    render(<PrevalenceFigure fig={fig} />);
    const el = screen.getByTestId("prevalence-figure");
    expect(el.className).not.toMatch(/border-l/);
    expect(screen.getByTestId("reliability-pill").className).not.toMatch(/border-l/);
  });

  it("renders nothing without figures", () => {
    const { container } = render(<PrevalenceFigure fig={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Pests tab severity rows", () => {
  it("carry the scope-wide figure line", () => {
    const data: PestsPayload = {
      filterOptions: { pests: ["Thrips"], sections: [], stages: [] },
      ranking: [{ name: "Thrips", total: 9, high: 1, moderate: 0, low: 0, ...fig }],
      distribution: [],
      sectionSplit: [],
      greenhousePressure: [],
      dailyPercent: [],
      trendSeries: { rows: [], keys: [] },
    };
    render(<PestsTab data={data} pestName="" section="" stage="" onFiltersChange={() => {}} />);
    expect(screen.getByText("33.3% (was 50%) · ±6 · 8/9")).toBeInTheDocument();
  });
});

describe("Pests tab by-variety card", () => {
  const variety = { variety: "Fuchsiana", beds: 6, scouted: 18, infested: 6, prevalence: 33.3, signs: 66.7, few: false };
  const base: PestsPayload = {
    filterOptions: { pests: ["Thrips"], sections: [], stages: [] },
    ranking: [], distribution: [], sectionSplit: [], greenhousePressure: [], dailyPercent: [],
    trendSeries: { rows: [], keys: [] },
    varieties: [variety],
  };

  it("says it is the all-stage live figure and titles the table once", () => {
    render(<PestsTab data={base} pestName="Thrips" section="" stage="Adult" onFiltersChange={() => {}} />);
    expect(screen.getByText(/All-stage live prevalence and signs of Thrips/)).toHaveTextContent(
      /not the selected stage or section/,
    );
    expect(screen.getAllByText(/By variety/i)).toHaveLength(1);
    expect(screen.getByText("By Variety")).toBeInTheDocument();
  });
});

describe("Overview active alerts", () => {
  // Since thresholds piece 3a the card lists stored Scouting Alerts (see
  // OverviewAlerts.test.tsx); the cached payload's activeAlerts is not drawn.
  it("no longer draws the cached payload's alerts", () => {
    const data: OverviewPayload = {
      kpis: { totalScouts: 1, zonesScouted: 27, greenhouseCount: 1, blockCount: 0, highAlerts: 1 },
      daily: [],
      rangeTotals: { pests: 0, diseases: 0, traps: 0 },
      ghHealth: [],
      topScouts: [],
      scoutsPerDay: [],
      scoutPerformance: [],
      recentActivity: [],
      activeAlerts: [{
        name: "Thrips", kind: "pest", severity: "high", count: 27,
        greenhouse: "Chepsito GH 01 - KR", zone: "9/27 scouted · 2031-W10", date: "2031-03-03",
        ...fig,
      }],
    };
    render(<OverviewTab data={data} scoutLookup={{}} fromDate="2031-03-03" toDate="2031-03-09" />);
    expect(screen.queryByText("33.3% (was 50%) · ±6 · 8/9")).toBeNull();
  });
});
