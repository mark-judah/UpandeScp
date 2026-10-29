import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fetchFarmsAndWarehousesResult = vi.fn();
vi.mock("@/lib/scouting-api", () => ({
  fetchFarmsAndWarehousesResult: (...a: unknown[]) => fetchFarmsAndWarehousesResult(...a),
  fetchFarmsAndWarehouses: vi.fn(),
  fetchCrops: vi.fn().mockResolvedValue([]),
  DEFAULT_CROP: "Rose",
}));
const fetchBlockCrops = vi.fn();
vi.mock("@/lib/open-field-api", () => ({ fetchBlockCrops: (...a: unknown[]) => fetchBlockCrops(...a) }));

import { __setCropProfiles } from "@/lib/crop-profile";
import { ALL, MapHeader } from "@/pages/maps/MapHeader";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const value = { crop: "Potato", farm: "Mutara", greenhouse: ALL, from: "2026-01-01", to: "2026-09-01" };

beforeEach(() => {
  fetchBlockCrops.mockReset().mockResolvedValue({
    "P1-B1 - MUT": { crop: "Potato", crop_label: "Potato", group: "Pivot 1 - MUT" },
    "P1-B2 - MUT": { crop: "Onion", crop_label: "Onion", group: "Pivot 1 - MUT" },
  });
  fetchFarmsAndWarehousesResult.mockReset().mockResolvedValue({ farms: { Mutara: ["P1-B1 - MUT", "P1-B2 - MUT"] } });
});

describe("MapHeader block picker on a pivot crop", () => {
  it("names the crop beside each block, highlighted", async () => {
    __setCropProfiles([{ crop: "Potato", label: "Potato", slug: "potato", station_type: "Block", block_grown: true, level_labels: ["Pivot"] }]);
    render(<MapHeader title="Scouting" subtitle="" value={value} onChange={() => {}} />);
    await waitFor(() => expect(fetchBlockCrops).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Farm and greenhouse" }));
    const row = await screen.findByRole("option", { name: /P1-B2/ });
    await waitFor(() => expect(within(row).getByTestId("crop-chip")).toHaveTextContent("Onion"));
  });

  it("greenhouse crops get no chip and no lookup", async () => {
    __setCropProfiles([{ crop: "Rose", label: "Rose", slug: "rose", station_type: "Greenhouse", block_grown: false, level_labels: [] }]);
    fetchBlockCrops.mockClear();
    render(<MapHeader title="Scouting" subtitle="" value={{ ...value, crop: "Rose" }} onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Farm and greenhouse" }));
    await screen.findByRole("listbox");
    expect(screen.queryByTestId("crop-chip")).toBeNull();
    expect(fetchBlockCrops).not.toHaveBeenCalled();
  });
});
