/**
 * In-place skeletons (spec 2026-10-11): with the aggregate still in flight the
 * page draws its real frame — title, tabs, card titles, KPI labels, table
 * headings — and only the data slots are skeletons. Once the data lands the
 * skeletons go. Runs the real `useDashboardAggregate` against a pending `call`.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Deferred = { resolve: (v: unknown) => void };
const pending: Deferred[] = [];
const call = vi.fn(
  () => new Promise((resolve) => pending.push({ resolve })),
);

vi.mock("@/lib/frappe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frappe")>()),
  call: (...a: unknown[]) => (call as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => {} }));
vi.mock("@/hooks/use-job-progress", () => ({ useJobProgress: () => null }));
vi.mock("@/hooks/use-crop-farms", () => ({
  useCropFarms: () => ({ farms: { Chepsito: ["GH1 - KR"] }, loading: false }),
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchScoutLookup: vi.fn().mockResolvedValue({}),
  fetchZonesByGreenhouse: vi.fn().mockResolvedValue({}),
  fetchFarmsAndWarehousesResult: vi.fn().mockResolvedValue({ farms: {} }),
  DEFAULT_CROP: "Rose",
}));
vi.mock("@/lib/scouting-alerts-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scouting-alerts-api")>()),
  listOpenAlerts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/observation-colors", () => ({
  useObservationColors: () => ({ map: {}, pest: () => "#000", disease: () => "#000" }),
}));
vi.mock("@/lib/thresholds-api", () => ({
  getThresholds: vi.fn().mockResolvedValue({ crop: "Rose", pests: [], diseases: [] }),
}));
vi.mock("@/pages/trends/TristateTree", () => ({ TristateTree: () => null }));
vi.mock("@/pages/trends/ChartPanel", () => ({ ChartPanel: () => null }));

import { Dashboard } from "@/pages/Dashboard";
import { Coverage } from "@/pages/Coverage";
import { Trends } from "@/pages/Trends";

beforeEach(() => {
  pending.length = 0;
  call.mockClear();
});

/** Resolve every in-flight `call` with `payload` (wrapped as Frappe does). */
async function land(payload: unknown) {
  await waitFor(() => expect(pending.length).toBeGreaterThan(0));
  await act(async () => {
    pending.splice(0).forEach((d) => d.resolve({ message: payload }));
  });
}

const skeletons = (root: HTMLElement) =>
  root.querySelectorAll('.animate-pulse, [data-skeleton]');

describe("Dashboard ▸ Overview while loading", () => {
  it("draws the frame with skeletons in the data slots, then fills in", async () => {
    const { container } = render(<Dashboard initialCrop="Rose" />);

    // The frame: title, tabs, KPI labels and card titles, no overlay.
    expect(screen.getByRole("heading", { name: "Scouting Dashboard" })).toBeInTheDocument();
    for (const tab of ["Overview", "Pests", "Diseases", "Traps", "FCM & Moths"]) {
      expect(screen.getByRole("tab", { name: tab })).toBeInTheDocument();
    }
    for (const label of ["Total Scouts", "Zones Scouted", "Greenhouses", "High Alerts"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const title of ["Activity Timeline", "Range Totals", "Scout Performance", "Greenhouse Health", "Top Scouts"]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(skeletons(container).length).toBeGreaterThan(0);
    // No empty-state wording while the data is on its way.
    expect(screen.queryByText("No timeline data")).toBeNull();
    expect(screen.queryByText("No greenhouses")).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument(); // inline progress

    await land({
      kpis: { totalScouts: 7, zonesScouted: 120, greenhouseCount: 4, blockCount: 0, highAlerts: 0 },
      daily: [], rangeTotals: { pests: 0, diseases: 0, traps: 0 }, ghHealth: [],
      topScouts: [], recentActivity: [], scoutsPerDay: [], scoutPerformance: [],
    });

    await waitFor(() => expect(screen.getByText("120")).toBeInTheDocument());
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelectorAll("[data-skeleton]")).toHaveLength(0);
    expect(screen.getByText("No timeline data")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Reports ▸ Coverage while loading", () => {
  it("keeps the tiles and table headings, with skeleton rows until the data lands", async () => {
    const { container } = render(<Coverage initialCrop="Rose" />);

    expect(screen.getByRole("heading", { name: "Coverage" })).toBeInTheDocument();
    for (const label of ["Station coverage", "Off-zone fixes", "Too fast", "GPS detail"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Coverage/ })).toBeInTheDocument(); // Houses header
    expect(screen.getByRole("button", { name: /Per hour/ })).toBeInTheDocument(); // Scouts header
    expect(container.querySelectorAll('[data-skeleton="row"]').length).toBeGreaterThan(0);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("Nothing needs attention")).toBeNull();

    await land({
      kpis: {
        entries: 10, houses: 0, scouts: 0, coveragePct: 55, offZonePct: null, zoneMapSuspect: false,
        tooFastPct: null, metadataPct: null, nothingFoundPct: null,
      },
      clamped: false,
      range: { from_date: "2026-09-11", to_date: "2026-10-11" },
      flags: [], houses: [], scouts: [],
      thresholds: {
        mapOffsetMedianM: 20, minFixes: 50, thinCoveragePct: 30, tooFastPct: 20, tooFastSeconds: 5,
        nothingFoundExcess: 25, nothingFoundMinEntries: 100, offZoneExcess: 25, zoneMapSuspectPct: 30,
        duplicatePct: 2, metadataMinPct: 50, staleDays: 14, maxRangeDays: 56, syncDelayFrom: "2026-09-02",
      },
    });

    await waitFor(() => expect(screen.getByText("55%")).toBeInTheDocument());
    expect(container.querySelectorAll("[data-skeleton]")).toHaveLength(0);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.getByText("Nothing needs attention")).toBeInTheDocument();
  });
});

describe("Scouting Trends while loading", () => {
  it("shows the header and pickers (disabled) without an overlay, enabling them once data lands", async () => {
    const { container } = render(<Trends initialCrop="Rose" />);

    expect(screen.getByRole("heading", { name: "Scouting Trends" })).toBeInTheDocument();
    const farms = screen.getByRole("button", { name: /Farms/ });
    const obs = screen.getByRole("button", { name: /Observations/ });
    expect(farms).toBeDisabled();
    expect(obs).toBeDisabled();
    expect(screen.getByText("Pick stations to start")).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
    // Not the old full-screen overlay.
    expect(container.querySelector(".fixed.inset-0")).toBeNull();

    await land({
      options: { farmStations: {}, pests: {}, diseases: {}, stagesByObs: {} },
      vocab: { weeks: [], stations: [], obs: [], stages: [""] },
      byAny: [], byKindName: [], byKindNameStage: [], scoutedByStation: [], intensityByStation: [],
      stationsByFarm: {}, unitsByStation: {}, allWeeks: [], unitTotalsByStation: {},
      unitLabel: "zone", unitLabelPlural: "zones",
    });

    await waitFor(() => expect(screen.getByRole("button", { name: /Farms/ })).toBeEnabled());
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
