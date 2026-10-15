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
vi.mock("@/pages/maps/Terrain3D", () => ({
  Terrain3D: ({ weeks }: { weeks: { date: string }[] }) => (
    <div data-testid="terrain3d">{weeks.map((w) => w.date).join(",")}</div>
  ),
}));

const { PestHeatmapModal, SUMMARY_METHOD } = await import("@/components/PestHeatmapModal");
const { METHOD } = await import("@/hooks/use-dashboard-aggregate");

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
  weeks: [
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
    await waitFor(() => expect(call).toHaveBeenCalledWith(METHOD.heatmap_terrain, expect.anything()));
    const summaryArgs = call.mock.calls.find((c) => c[0] === SUMMARY_METHOD)![1];
    expect(summaryArgs).toMatchObject({
      greenhouse: "GH 1", obs_name: "Spider Mites", crop: "Rose", weeks: 2, to_date: "2026-10-15",
    });
    const detailArgs = call.mock.calls.find((c) => c[0] === METHOD.heatmap_terrain)![1];
    expect(detailArgs).toMatchObject({
      greenhouse: "GH 1", obs_name: "Spider Mites", obs_kind: "pest", crop: "Rose",
      from_date: "2026-10-02", to_date: "2026-10-15",
    });
  });

  it("honours defaultWeeks and a stated kind", async () => {
    render(
      <PestHeatmapModal greenhouse="GH 1" observation="Botrytis" kind="disease" crop="Rose"
        toDate="2026-10-15" defaultWeeks={4} onClose={() => {}} />,
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith(METHOD.heatmap_terrain, expect.anything()));
    const detailArgs = call.mock.calls.find((c) => c[0] === METHOD.heatmap_terrain)![1];
    expect(detailArgs).toMatchObject({ obs_kind: "disease", from_date: "2026-09-18" });
    expect(call.mock.calls.find((c) => c[0] === SUMMARY_METHOD)![1]).toMatchObject({ obs_kind: "disease", weeks: 4 });
  });

  it("is landscape: 3D terrain left, week pills and summary in the side panel", async () => {
    render(<PestHeatmapModal greenhouse="GH 1" observation="Spider Mites" crop="Rose" toDate="2026-10-15" onClose={() => {}} />);
    expect(screen.getByTestId("pest-heatmap-modal").className).toMatch(/w-\[90vw\]/);
    expect(screen.getByTestId("pest-heatmap-modal").className).toMatch(/h-\[70vh\]/);
    const terrain = await screen.findByTestId("terrain3d");
    expect(terrain).toHaveTextContent("2026-W40,2026-W41");
    const side = screen.getByTestId("heatmap-side");
    expect(side).toContainElement(await screen.findByTestId("band-pill"));
    expect(await screen.findByTestId("band-pill")).toHaveTextContent("high band");
    expect(screen.getByText(/Bands: low 5 · moderate 10 · high 20%/)).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-trend")).toBeInTheDocument();
    expect(screen.getByTestId("heatmap-3d")).not.toContainElement(side);
  });

  it("week pills pick 1/2/4 weeks or one specific week", async () => {
    render(<PestHeatmapModal greenhouse="GH 1" observation="Spider Mites" crop="Rose" toDate="2026-10-15" onClose={() => {}} />);
    await screen.findByTestId("terrain3d");
    await userEvent.click(screen.getByRole("button", { name: "4 weeks" }));
    await waitFor(() =>
      expect(call.mock.calls.filter((c) => c[0] === METHOD.heatmap_terrain).pop()![1]).toMatchObject({ from_date: "2026-09-18" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "W41" }));
    expect(screen.getByTestId("terrain3d")).toHaveTextContent(/^2026-W41$/);
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
