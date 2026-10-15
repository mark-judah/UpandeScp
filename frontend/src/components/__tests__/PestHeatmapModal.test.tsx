import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("@/lib/frappe", async (orig) => ({
  ...(await orig<typeof import("@/lib/frappe")>()),
  call: (...a: unknown[]) => call(...a),
}));
vi.mock("@/lib/scouting-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/scouting-api")>()),
  fetchBedsAndZones: () => Promise.resolve([]),
}));
vi.mock("@/pages/maps/use-house-overlays", () => ({
  useHouseOverlays: vi.fn(() => ({ clusters: null, pins: [], reloadPins: () => {} })),
  bedOverlays: () => [],
}));

const { PestHeatmapModal, SUMMARY_METHOD } = await import("@/components/PestHeatmapModal");
const { METHOD } = await import("@/hooks/use-dashboard-aggregate");
const { useHouseOverlays } = await import("@/pages/maps/use-house-overlays");

const SUMMARY = {
  greenhouse: "GH 1", obsName: "Spider Mites", obsKind: "pest", measure: "Percentage",
  threshold: { low: 5, moderate: 10, high: 20, measure: "Percentage" },
  latest: {
    prevalence: 24, prev: 12, margin: 6, sections_scouted: 8, sections_total: 9,
    reliability: "Good", value: 24, band: "high", week: "2026-W41",
  },
  series: [
    { week: "2026-W40", value: 12, prevalence: 12, reliability: "Good", band: "moderate" },
    { week: "2026-W41", value: 24, prevalence: 24, reliability: "Good", band: "high" },
  ],
};
const DETAIL = {
  recent: [
    { date: "2026-W40", zoneObs: { "GH 1 - Bed 1": 2 } },
    { date: "2026-W41", zoneObs: { "GH 1 - Bed 1": 5, "GH 1 - Bed 2": 1 } },
  ],
};

beforeEach(() => {
  call.mockReset();
  call.mockImplementation((method: string) =>
    Promise.resolve(method === SUMMARY_METHOD ? SUMMARY : DETAIL),
  );
});

describe("PestHeatmapModal", () => {
  it("stays closed without a greenhouse or observation", () => {
    render(<PestHeatmapModal greenhouse={null} observation="Spider Mites" crop="Rose" onClose={() => {}} />);
    expect(screen.queryByTestId("pest-heatmap-modal")).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("asks the summary and card-detail endpoints for THIS house, pest, crop and window", async () => {
    render(
      <PestHeatmapModal greenhouse="GH 1" observation="Spider Mites" crop="Rose"
        toDate="2026-10-15" onClose={() => {}} />,
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith(METHOD.heatmap_card_detail, expect.anything()));
    const summaryArgs = call.mock.calls.find((c) => c[0] === SUMMARY_METHOD)![1];
    expect(summaryArgs).toMatchObject({
      greenhouse: "GH 1", obs_name: "Spider Mites", crop: "Rose", weeks: 2, to_date: "2026-10-15",
    });
    const detailArgs = call.mock.calls.find((c) => c[0] === METHOD.heatmap_card_detail)![1];
    expect(detailArgs).toMatchObject({
      greenhouse: "GH 1", obs_name: "Spider Mites", obs_kind: "pest", crop: "Rose",
      weeks_limit: 2, from_date: "2026-10-02", to_date: "2026-10-15",
    });
  });

  it("honours defaultWeeks and a stated kind", async () => {
    render(
      <PestHeatmapModal greenhouse="GH 1" observation="Botrytis" kind="disease" crop="Rose"
        toDate="2026-10-15" defaultWeeks={4} onClose={() => {}} />,
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith(METHOD.heatmap_card_detail, expect.anything()));
    const detailArgs = call.mock.calls.find((c) => c[0] === METHOD.heatmap_card_detail)![1];
    expect(detailArgs).toMatchObject({ obs_kind: "disease", weeks_limit: 4, from_date: "2026-09-18" });
    expect(call.mock.calls.find((c) => c[0] === SUMMARY_METHOD)![1]).toMatchObject({ obs_kind: "disease", weeks: 4 });
  });

  it("shows the figure, its band, the threshold and the weekly trend", async () => {
    render(<PestHeatmapModal greenhouse="GH 1" observation="Spider Mites" crop="Rose" toDate="2026-10-15" onClose={() => {}} />);
    expect(await screen.findByTestId("band-pill")).toHaveTextContent("high band");
    expect(screen.getByText(/Bands: low 5 · moderate 10 · high 20%/)).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-trend")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("heatmap-weeks").children).toHaveLength(2));
    // The patches overlay follows the observation shown.
    expect(vi.mocked(useHouseOverlays)).toHaveBeenCalledWith(
      expect.objectContaining({ warehouse: "GH 1", observation: "Spider Mites", crop: "Rose" }),
    );
  });

  it("says so when the pest was not scouted in the window", async () => {
    call.mockImplementation((m: string) =>
      Promise.resolve(m === SUMMARY_METHOD ? { ...SUMMARY, latest: null, series: [] } : { recent: [] }));
    render(<PestHeatmapModal greenhouse="GH 1" observation="Spider Mites" crop="Rose" toDate="2026-10-15" onClose={() => {}} />);
    expect(await screen.findByText(/No scouting of Spider Mites in GH 1/)).toBeInTheDocument();
    expect(screen.getByText(/No threshold bands set|Bands:/)).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<PestHeatmapModal greenhouse="GH 1" observation="Spider Mites" crop="Rose" onClose={onClose} />);
    await screen.findByTestId("pest-heatmap-modal");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
