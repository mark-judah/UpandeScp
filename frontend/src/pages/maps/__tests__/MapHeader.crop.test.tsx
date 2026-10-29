import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFarmsAndWarehousesResult = vi.fn();
const fetchCrops = vi.fn();
vi.mock("@/lib/scouting-api", () => ({
  fetchFarmsAndWarehousesResult: (...a: unknown[]) => fetchFarmsAndWarehousesResult(...a),
  fetchFarmsAndWarehouses: vi.fn(),
  fetchCrops: (...a: unknown[]) => fetchCrops(...a),
  DEFAULT_CROP: "Rose",
}));

import { ALL, MapHeader } from "@/pages/maps/MapHeader";

beforeEach(() => {
  fetchCrops.mockReset().mockResolvedValue([]);
  fetchFarmsAndWarehousesResult.mockReset().mockResolvedValue({
    farms: { Lokitela: ["AIRSTRIP BLK 1 - KL"] },
  });
});

describe("MapHeader on the avocado Application Plan", () => {
  it("lists the crop's farms from the server and has no crop picker", async () => {
    const onChange = vi.fn();
    render(
      <MapHeader
        title="Application Plan"
        subtitle=""
        value={{ crop: "Avocado", farm: ALL, greenhouse: ALL, from: "2026-01-01", to: "2026-09-01" }}
        onChange={onChange}
        showGreenhouse={false}
      />,
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ farm: "Lokitela" })),
    );
    expect(fetchFarmsAndWarehousesResult).toHaveBeenCalledWith("Avocado");
    expect(fetchCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });
});
