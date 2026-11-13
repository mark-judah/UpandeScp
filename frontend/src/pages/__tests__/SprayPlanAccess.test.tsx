import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const row = (user: string, full_name: string) => ({ user, full_name });

const listMock = vi.fn();
const setCreators = vi.fn();
const setSupervisors = vi.fn();

vi.mock("@/lib/spray-plan-admin-api", () => ({
  listFarmsWithCreators: (...a: unknown[]) => listMock(...a),
  setFarmCreators: (...a: unknown[]) => setCreators(...a),
  setFarmSupervisors: (...a: unknown[]) => setSupervisors(...a),
  listCreatorCandidates: async () => [],
  listApproverCandidates: async () => [],
  listStoreKeeperCandidates: async () => [],
  listProductionSupervisorCandidates: async () => [],
  listSupervisorCandidates: async () => [
    { user: "sam@x.co", full_name: "Sam Sup", email: "sam@x.co" },
  ],
}));

const { SprayPlanAccess } = await import("@/pages/SprayPlanAccess");

describe("Farm access page", () => {
  beforeEach(() => {
    listMock.mockReset();
    setCreators.mockReset();
    setSupervisors.mockReset();
    listMock.mockResolvedValue([
      {
        farm: "Chepsito", farm_name: "Chepsito", business_unit: "BU",
        creators: [row("c@x.co", "Cora Creator")],
        supervisors: [row("s@x.co", "Sue Supervisor")],
        approvers: [], store_keepers: [], production_supervisors: [],
        chemical_store: null, fertilizer_store: null,
      },
    ]);
  });

  it("shows both rosters and the supervisor explanation", async () => {
    render(<SprayPlanAccess />);
    expect(await screen.findByText("Cora Creator")).toBeTruthy();
    expect(screen.getByText("Sue Supervisor")).toBeTruthy();
    expect(screen.getByText("Farm access")).toBeTruthy();
    expect(screen.getByText("Spray plan creators")).toBeTruthy();
    expect(screen.getByText("Spray supervisors")).toBeTruthy();
    expect(screen.getByText(/Can confirm the tank mix and scan, start and stop sprays/)).toBeTruthy();
  });

  it("saves only the supervisor roster when only it changed", async () => {
    setSupervisors.mockResolvedValue({ farm: "Chepsito", supervisors: [] });
    render(<SprayPlanAccess />);
    await screen.findByText("Sue Supervisor");
    expect(screen.queryByText(/Save all/)).toBeNull();
    await userEvent.click(screen.getByLabelText("Remove Sue Supervisor"));
    await userEvent.click(await screen.findByText("Save all (1)"));
    await waitFor(() => expect(setSupervisors).toHaveBeenCalledWith("Chepsito", []));
    expect(setCreators).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText(/Save all/)).toBeNull());
  });

  it("keeps the row dirty and shows the server message when a save is refused", async () => {
    setSupervisors.mockRejectedValue(new Error("These users do not have the 'SCP Spray Supervisor' role: s@x.co."));
    render(<SprayPlanAccess />);
    await screen.findByText("Sue Supervisor");
    await userEvent.click(screen.getByLabelText("Remove Sue Supervisor"));
    await userEvent.click(await screen.findByText("Save all (1)"));
    expect(await screen.findByText(/do not have the 'SCP Spray Supervisor' role/)).toBeTruthy();
    expect(screen.getByText("Save all (1)")).toBeTruthy();
  });
});
