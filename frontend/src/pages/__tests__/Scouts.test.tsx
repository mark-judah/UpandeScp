import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScoutRecord, ScoutsPayload } from "@/lib/scouts-api";

function scout(over: Partial<ScoutRecord>): ScoutRecord {
  return {
    scout: "HR-1", scoutName: "Ann Chebet", entries: 1000, activeDays: 20, entriesPerHour: 120,
    bedsPerDay: 10, moves: 500, tooFastPct: 2, nothingFoundPct: 50, fixes: 900, metadataPct: 90,
    offZonePct: 60, houseOffZonePct: 58, duplicates: 1, duplicatePct: 0.1, medianSyncMin: 3, syncSample: 900,
    stationsPerDay: 400, houses: [{ house: "Chepsito GH 01 - KR", entries: 700 }, { house: "Chepsito GH 02 - KR", entries: 300 }],
    weeks: [{ week: 203139, entries: 400 }, { week: 203140, entries: 600 }], lastDate: "2031-10-04",
    farms: ["Chepsito"], farm: "Chepsito", entriesPerDay: 50, eligible: true, image: "", flags: [],
    rank: 1, score: 98.5, effort: 100, integrity: 97.9, gps: 98, gpsNote: null,
    ...over,
  };
}

const PAYLOAD: ScoutsPayload = {
  ranked: [
    scout({}),
    scout({
      scout: "HR-2", scoutName: "Ben Kiprop", rank: 2, score: 61.2, effort: 20, integrity: 76, gps: 100,
      tooFastPct: 23.8, image: "/files/ben.jpg",
      flags: [{ kind: "too_fast", subject: "scout", name: "HR-2", label: "Ben Kiprop", value: 23.8,
                threshold: 20, unit: "%", score: 0.19, detail: "23.8% of zone-to-zone moves under 5 s" }],
    }),
  ],
  notEnoughDays: [scout({ scout: "HR-3", scoutName: "Cy Too-New", activeDays: 2, eligible: false,
                          rank: undefined, score: undefined, effort: undefined, integrity: undefined, gps: undefined })],
  medians: [{ farm: "Chepsito", scouts: 2, stationsPerDay: 300, entriesPerDay: 50, entriesPerHour: 120,
              tooFastPct: 12.9, duplicatePct: 0.1, offZonePct: 60, nothingFoundPct: 50 }],
  farm: "", farms: ["Chepsito"], allFarms: true,
  range: { from_date: "2031-09-08", to_date: "2031-10-05" }, clamped: false,
  weights: { effort: 0.4, integrity: 0.3, gps: 0.3 }, minActiveDays: 5,
  defaultRange: { from_date: "2031-09-08", to_date: "2031-10-05" },
};

const useDashboardAggregate = vi.fn(() => ({
  data: PAYLOAD, loading: false, error: null, progress: null, reload: vi.fn(),
}));
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...(a as [])),
}));

const { Scouts, lastFourWeeks } = await import("@/pages/Scouts");

describe("Personnel ▸ Scouts", () => {
  beforeEach(() => useDashboardAggregate.mockClear());

  it("asks for the scouts ranking over the last four complete weeks", () => {
    render(<Scouts initialCrop="Rose" />);
    const [endpoint, filters] = useDashboardAggregate.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(endpoint).toBe("scouts");
    expect(filters).toMatchObject({ crop: "Rose", farm: "", ...{ from_date: lastFourWeeks().from, to_date: lastFourWeeks().to } });
    // Sunday 2026-10-11 → the four weeks before it; Monday 2026-10-12 → up to that Sunday
    expect(lastFourWeeks(new Date(2026, 9, 11))).toEqual({ from: "2026-09-07", to: "2026-10-04" });
    expect(lastFourWeeks(new Date(2026, 9, 12))).toEqual({ from: "2026-09-14", to: "2026-10-11" });
  });

  it("lists the ranking with rank and score, and the scouts with too few days apart", () => {
    render(<Scouts initialCrop="Rose" />);
    const first = screen.getByTestId("person-HR-1");
    expect(within(first).getByText("1")).toBeInTheDocument();
    expect(within(first).getByText("98.5")).toBeInTheDocument();
    expect(within(screen.getByTestId("person-HR-2")).getByText("61.2")).toBeInTheDocument();
    expect(screen.getByText("Not enough days")).toBeInTheDocument();
    expect(within(screen.getByTestId("person-HR-3")).queryByText(/score/)).toBeNull();
  });

  it("opens the record: portrait, score parts, farm median, houses, weeks, flags", async () => {
    render(<Scouts initialCrop="Rose" />);
    let record = screen.getByTestId("scout-record");
    expect(within(record).getByLabelText("Ann Chebet — no photograph")).toBeInTheDocument();
    expect(within(record).getByRole("img", { name: "Score parts" })).toBeInTheDocument();
    expect(within(record).getByTestId("radar-benchmark")).toBeInTheDocument();
    expect(within(record).getByRole("table", { name: "Against the farm median" })).toBeInTheDocument();
    expect(within(record).getByText("Chepsito GH 01 - KR")).toBeInTheDocument();
    expect(within(record).getByText("70%")).toBeInTheDocument();
    expect(within(record).getByText(/W40 · 600 entries/)).toBeInTheDocument();
    expect(within(record).getByText("No open flags.")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("person-HR-2"));
    record = screen.getByTestId("scout-record");
    expect(within(record).getByAltText("Ben Kiprop")).toHaveAttribute("src", "/files/ben.jpg");
    expect(within(record).getByText("Too fast")).toBeInTheDocument();
    expect(within(record).getByText(/23.8% of zone-to-zone moves/)).toBeInTheDocument();
    await userEvent.click(within(record).getByRole("button", { name: /Compare against the farm/ }));
    expect(await screen.findByRole("table", { name: "Comparison figures" })).toBeInTheDocument();
  });

  it("a scout with too few days is shown but not ranked", async () => {
    render(<Scouts initialCrop="Rose" />);
    await userEvent.click(screen.getByTestId("person-HR-3"));
    const record = screen.getByTestId("scout-record");
    expect(within(record).getByText("Not ranked")).toBeInTheDocument();
    expect(within(record).getByRole("button", { name: /Compare against the farm/ })).toBeDisabled();
  });

  it("draws no left-border accent strips", () => {
    const { container } = render(<Scouts initialCrop="Rose" />);
    expect(container.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});
