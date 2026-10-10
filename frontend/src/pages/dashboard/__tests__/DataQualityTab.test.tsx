import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataQualityTab } from "../DataQualityTab";
import type { QualityPayload } from "../quality-types";

const DATA: QualityPayload = {
  kpis: {
    entries: 1200, houses: 2, scouts: 2, coveragePct: 41.5, offZonePct: 22.4,
    zoneMapSuspect: true, tooFastPct: 12.1, metadataPct: 64.0, nothingFoundPct: 50.0,
  },
  flags: [
    { kind: "map_offset", subject: "house", name: "GH 2", label: "GH 2", value: 31.2, threshold: 20,
      unit: "m", score: 0.56, detail: "median fix 31.2 m from its zone over 400 fixes — check the zone map" },
    { kind: "too_fast", subject: "scout", name: "E1", label: "Jane Doe", value: 28, threshold: 20,
      unit: "%", score: 0.4, detail: "28% of entries under 5 s after the previous" },
  ],
  houses: [
    { house: "GH 1", week: "2026-W41", weekPartial: true, stations: 400, stationsScouted: 100, coveragePct: 25, sectionsScouted: 7,
      entries: 500, scouts: 2, nothingFoundPct: 60, fixes: 0, metadataPct: 0, offZonePct: null,
      medianDistance: null, p90Distance: null, gpsReliable: false },
    { house: "GH 2", week: "2026-W40", weekPartial: false, stations: 300, stationsScouted: 240, coveragePct: 80, sectionsScouted: 9,
      entries: 700, scouts: 1, nothingFoundPct: 40, fixes: 700, metadataPct: 100, offZonePct: 40,
      medianDistance: 31.2, p90Distance: 55.0, gpsReliable: true },
  ],
  scouts: [
    { scout: "E1", scoutName: "Jane Doe", entries: 900, activeDays: 5, entriesPerHour: 120, bedsPerDay: 40,
      moves: 800, tooFastPct: 28, nothingFoundPct: 45, fixes: 700, metadataPct: 77.8, offZonePct: 30, houseOffZonePct: 22, duplicates: 9,
      duplicatePct: 1, medianSyncMin: 12, syncSample: 900 },
    { scout: "E2", scoutName: "Ann Roe", entries: 300, activeDays: 2, entriesPerHour: 80, bedsPerDay: 20,
      moves: 250, tooFastPct: 3, nothingFoundPct: 65, fixes: 0, metadataPct: 0, offZonePct: null, houseOffZonePct: null, duplicates: 0,
      duplicatePct: 0, medianSyncMin: null, syncSample: 0 },
  ],
  thresholds: {
    mapOffsetMedianM: 20, minFixes: 50, thinCoveragePct: 30, tooFastPct: 20, tooFastSeconds: 5,
    nothingFoundExcess: 25, nothingFoundMinEntries: 100, offZoneExcess: 25, zoneMapSuspectPct: 30, duplicatePct: 2,
    metadataMinPct: 50, syncDelayFrom: "2026-09-02",
  },
};

describe("DataQualityTab", () => {
  it("renders the KPI tiles", () => {
    render(<DataQualityTab data={DATA} />);
    for (const label of ["Station coverage", "Off-zone fixes", "Too fast", "GPS detail"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("41.5%")).toBeInTheDocument();
    expect(screen.getByText("64%")).toBeInTheDocument();
  });

  it("lists the flags with a pill per kind, most urgent first", () => {
    render(<DataQualityTab data={DATA} />);
    const flags = screen.getAllByTestId("quality-flag");
    expect(flags).toHaveLength(2);
    expect(within(flags[0]).getByText("Map offset?")).toBeInTheDocument();
    expect(within(flags[0]).getByText("GH 2")).toBeInTheDocument();
    expect(within(flags[1]).getByText("Too fast")).toBeInTheDocument();
    expect(within(flags[1]).getByText("Jane Doe")).toBeInTheDocument();
  });

  it("greys a house's GPS columns when its metadata is thin", () => {
    render(<DataQualityTab data={DATA} />);
    const rows = screen.getAllByTestId("quality-house");
    const gh1 = rows.find((r) => within(r).queryByText("GH 1"))!;
    const gh2 = rows.find((r) => within(r).queryByText("GH 2"))!;
    expect(gh1).toHaveAttribute("data-gps", "thin");
    expect(within(gh1).getAllByText("no GPS detail").length).toBeGreaterThan(0);
    expect(gh2).toHaveAttribute("data-gps", "ok");
    expect(within(gh2).getByText("31.2 m")).toBeInTheDocument();
  });

  it("sorts the scout table by a column", () => {
    render(<DataQualityTab data={DATA} />);
    const names = () => screen.getAllByTestId("quality-scout").map((r) => r.getAttribute("data-scout"));
    expect(names()).toEqual(["E1", "E2"]);  // entries, high first
    fireEvent.click(screen.getByRole("button", { name: /Nothing found/ }));
    expect(names()).toEqual(["E2", "E1"]);
  });

  it("says the zone map needs checking when the scope's off-zone share is high", () => {
    render(<DataQualityTab data={DATA} />);
    expect(screen.getByText(/zone map needs checking/)).toBeInTheDocument();
    render(<DataQualityTab data={{ ...DATA, kpis: { ...DATA.kpis, zoneMapSuspect: false } }} />);
    expect(screen.getAllByText(/zone map needs checking/)).toHaveLength(1);
  });

  it("marks a partial-week coverage and compares a scout's off zone with their houses", () => {
    render(<DataQualityTab data={DATA} />);
    const gh1 = screen.getAllByTestId("quality-house").find((r) => within(r).queryByText("GH 1"))!;
    expect(within(gh1).getByText("partial week")).toBeInTheDocument();
    const e1 = screen.getAllByTestId("quality-scout").find((r) => r.getAttribute("data-scout") === "E1")!;
    expect(within(e1).getByText("30% vs 22%")).toBeInTheDocument();
  });

  it("explains that sync is creation minus capture", () => {
    render(<DataQualityTab data={DATA} />);
    expect(screen.getByText(/creation minus capture/)).toBeInTheDocument();
  });

  it("shows an empty state with no data", () => {
    render(<DataQualityTab data={{ ...DATA, flags: [], houses: [], scouts: [] }} />);
    expect(screen.getByText("Nothing needs attention")).toBeInTheDocument();
  });

  it("never draws a coloured left-border strip", () => {
    const { container } = render(<DataQualityTab data={DATA} />);
    const all = Array.from(container.querySelectorAll("*"));
    expect(all.filter((el) => /(^|\s)border-l(-|\s|$)/.test(el.getAttribute("class") || ""))).toEqual([]);
  });
});
