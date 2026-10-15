import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useDashboardAggregate = vi.fn();
const fetchCrops = vi.fn();

vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchCrops: (...a: unknown[]) => fetchCrops(...a),
  DEFAULT_CROP: "Rose",
}));
vi.mock("@/lib/thresholds-api", () => ({
  getThresholds: vi.fn().mockResolvedValue({ crop: "Rose", pests: [], diseases: [] }),
}));
vi.mock("@/components/TreePicker", () => ({ TreePicker: () => null }));
vi.mock("@/pages/trends/ChartPanel", () => ({ ChartPanel: () => null }));
vi.mock("@/components/LoadingOverlay", () => ({ LoadingOverlay: () => null }));

import { Trends } from "@/pages/Trends";

beforeEach(() => {
  useDashboardAggregate.mockReset().mockReturnValue({
    data: null, loading: false, error: null, progress: null, reload: vi.fn(),
  });
  fetchCrops.mockReset().mockResolvedValue([]);
});

describe("Trends follows the route crop", () => {
  it.each(["Rose", "Coffee"])("asks for %s trends and shows no crop picker", (crop) => {
    render(<Trends initialCrop={crop} />);
    expect(useDashboardAggregate).toHaveBeenCalledWith(
      "trends", expect.objectContaining({ crop }), true,
    );
    expect(fetchCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });
});
