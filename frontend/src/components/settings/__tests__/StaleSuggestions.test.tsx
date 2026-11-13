import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getStalePlans = vi.fn();
const stopStalePlans = vi.fn();
vi.mock("@/lib/scouting-api", () => ({
  getStalePlans: (...a: unknown[]) => getStalePlans(...a),
  stopStalePlans: (...a: unknown[]) => stopStalePlans(...a),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ show: vi.fn() }) }));

import { StaleSuggestionsLink } from "@/components/settings/StaleSuggestionsLink";
import { StalePlansTab } from "@/components/spray-plan/StalePlansTab";

const plan = {
  name: "MFG-WO-1", docstatus: 1, status: "Not Started", workflow_state: "Approved",
  planned_start_date: "2026-11-20 06:00:00", creation: "2026-11-01 08:00:00",
  hold_started: "2026-11-01", owner: "a@b.c", custom_greenhouse: "GH 4",
  items: ["Chem A"], held: [{ item: "Chem A", warehouse: "Store", qty: 2.5 }],
};

beforeEach(() => {
  getStalePlans.mockReset();
  stopStalePlans.mockReset();
});

describe("StaleSuggestionsLink", () => {
  it("links to the stale list with the count", async () => {
    getStalePlans.mockResolvedValue([plan, { ...plan, name: "MFG-WO-2" }]);
    render(<StaleSuggestionsLink />);
    const a = await screen.findByText("2 plans suggested for cancelling — review");
    expect(a.getAttribute("href")).toMatch(/approvals\?tab=stale$/);
  });

  it("shows nothing when the list is unavailable", async () => {
    getStalePlans.mockRejectedValue(new Error("no"));
    const { container } = render(<StaleSuggestionsLink />);
    await waitFor(() => expect(getStalePlans).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});

describe("StalePlansTab", () => {
  it("lists plan, house, spray date, planned on, creator and held; cancels the selection", async () => {
    getStalePlans.mockResolvedValue([plan]);
    stopStalePlans.mockResolvedValue({ stopped: ["MFG-WO-1"], deleted: [], skipped: [], failed: [] });
    render(<StalePlansTab crop="Rose" />);
    expect(await screen.findByText("MFG-WO-1")).toBeInTheDocument();
    expect(screen.getByText("GH 4")).toBeInTheDocument();
    expect(screen.getByText(/spray 2026-11-20/)).toBeInTheDocument();
    expect(screen.getByText(/planned\s+2026-11-01/)).toBeInTheDocument();
    expect(screen.getByText(/by a@b.c/)).toBeInTheDocument();
    expect(screen.getByTestId("stale-held").textContent).toContain("2.5 x Chem A");
    await userEvent.click(screen.getByLabelText("Select MFG-WO-1"));
    await userEvent.click(screen.getByRole("button", { name: /Cancel selected/ }));
    await waitFor(() => expect(stopStalePlans).toHaveBeenCalledWith(["MFG-WO-1"]));
  });
});
