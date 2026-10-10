import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useDashboardAggregate = vi.fn();
const fetchFarmsAndWarehousesResult = vi.fn();
const fetchCrops = vi.fn();

vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchFarmsAndWarehousesResult: (...a: unknown[]) => fetchFarmsAndWarehousesResult(...a),
  fetchFarmsAndWarehouses: vi.fn(),
  fetchCrops: (...a: unknown[]) => fetchCrops(...a),
  fetchScoutLookup: vi.fn().mockResolvedValue({}),
  fetchZonesByGreenhouse: vi.fn().mockResolvedValue({}),
  DEFAULT_CROP: "Rose",
}));
vi.mock("@/pages/dashboard/OverviewTab", () => ({ OverviewTab: () => null }));
vi.mock("@/pages/dashboard/PestsTab", () => ({ PestsTab: () => null }));
vi.mock("@/pages/dashboard/DiseasesTab", () => ({ DiseasesTab: () => null }));
vi.mock("@/pages/dashboard/TrapsTab", () => ({ TrapsTab: () => null }));
vi.mock("@/pages/dashboard/FcmTab", () => ({ FcmTab: () => null }));
vi.mock("@/pages/dashboard/DataQualityTab", () => ({ DataQualityTab: () => null }));
vi.mock("@/components/LoadingOverlay", () => ({ LoadingOverlay: () => null }));

import { Dashboard } from "@/pages/Dashboard";

beforeEach(() => {
  useDashboardAggregate.mockReset().mockReturnValue({
    data: null, loading: false, error: null, progress: null, reload: vi.fn(),
  });
  fetchCrops.mockReset().mockResolvedValue([]);
  fetchFarmsAndWarehousesResult.mockReset().mockResolvedValue({ farms: { Lokitela: ["AIRSTRIP BLK 1 - KL"] } });
});

describe("Dashboard follows the route crop", () => {
  it("sends the route crop and asks for that crop's farms", async () => {
    render(<Dashboard initialCrop="Avocado" />);
    await waitFor(() => expect(fetchFarmsAndWarehousesResult).toHaveBeenCalledWith("Avocado"));
    const overview = useDashboardAggregate.mock.calls.find((c) => c[0] === "overview");
    expect(overview?.[1]).toMatchObject({ crop: "Avocado" });
    expect(fetchCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });

  it("asks for the quality aggregate with the same scope as the other tabs", () => {
    render(<Dashboard initialCrop="Rose" />);
    const quality = useDashboardAggregate.mock.calls.find((c) => c[0] === "quality");
    expect(quality?.[1]).toMatchObject({ crop: "Rose", farm: "", greenhouse: "" });
    expect(quality?.[2]).toBe(false);  // only fetched while its tab is open
    expect(screen.getByRole("tab", { name: "Data quality" })).toBeInTheDocument();
  });

  it("sends Rose as Rose, not as the old empty string", () => {
    render(<Dashboard initialCrop="Rose" />);
    const overview = useDashboardAggregate.mock.calls.find((c) => c[0] === "overview");
    expect(overview?.[1]).toMatchObject({ crop: "Rose" });
  });
});
