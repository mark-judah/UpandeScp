import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCreatorBootstrap = vi.fn();
vi.mock("@/lib/spray-plan-creator-api", () => ({
  fetchCreatorBootstrap: (...a: unknown[]) => fetchCreatorBootstrap(...a),
  createDraftSprayPlan: vi.fn(),
}));

import { screen } from "@testing-library/react";
import { BlockSprayPlan } from "@/pages/avocado/BlockSprayPlan";

const BOOT = {
  scope: { farms: ["Lokitela"], allowed_warehouses: [] },
  greenhouses: [],
  blocks: [{ name: "AIRSTRIP BLK 1 - KL", custom_farm: "Lokitela", latitude: null, longitude: null, cost_center: null, area_ha: 2 }],
  kits: [], spray_teams: [], tank_mixes: [], rate_limits: {},
  pest_catalog: [], disease_catalog: [], cost_centers: [], weather_settings: {},
  irac_window_days: 14, frac_window_days: 21, farm_stores: {},
};

beforeEach(() => fetchCreatorBootstrap.mockReset().mockResolvedValue(BOOT));

describe("BlockSprayPlan", () => {
  it("bootstraps for the crop it is given", async () => {
    render(<BlockSprayPlan block="AIRSTRIP BLK 1 - KL" crop="Coffee" />);
    await waitFor(() => expect(fetchCreatorBootstrap).toHaveBeenCalledWith("Coffee"));
  });

  it("defaults to Avocado", async () => {
    render(<BlockSprayPlan block="AIRSTRIP BLK 1 - KL" />);
    await waitFor(() => expect(fetchCreatorBootstrap).toHaveBeenCalledWith("Avocado"));
  });

  it("sums the area of joined blocks and names the primary", async () => {
    fetchCreatorBootstrap.mockResolvedValue({
      ...BOOT,
      blocks: [
        { ...BOOT.blocks[0], name: "A - KL", area_ha: 2 },
        { ...BOOT.blocks[0], name: "B - KL", area_ha: 3 },
      ],
    });
    render(<BlockSprayPlan blocks={["A - KL", "B - KL"]} />);
    expect(await screen.findByText("5.00 ha")).toBeTruthy();
    expect(screen.getByText("B - KL (primary)")).toBeTruthy();
    expect(screen.getByText("5000 L")).toBeTruthy();
  });
});
