import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchPlannedTransfers = vi.fn();
const fetchPlannedItems = vi.fn();

vi.mock("@/lib/store-keeper-api", () => ({
  fetchPlannedTransfers: (...a: unknown[]) => fetchPlannedTransfers(...a),
  fetchPlannedItems: (...a: unknown[]) => fetchPlannedItems(...a),
}));

import { PlannedChemicalsPanel } from "@/components/PlannedChemicalsPanel";

const RESP = {
  state: "Awaiting Approval",
  farms: ["Chepsito"],
  rows: [
    {
      work_order: "MFG-WO-2026-05218",
      planned_date: "2026-09-04 06:00:00",
      greenhouse: "Chepsito GH 19 - KR",
      farm: "Chepsito",
      item_count: 2,
      total_qty: 1.5,
    },
  ],
  totals: [
    { item_code: "1110009", item_name: "IMPULSE EC500", uom: "Litre", total_qty: 1.1 },
    { item_code: "1114008", item_name: "POLAR 50%", uom: "Kilogram", total_qty: 0.4 },
  ],
};

const ITEMS = [
  {
    item_code: "1110009",
    item_name: "IMPULSE EC500",
    qty: 1.1,
    uom: "Litre",
    from_warehouse: "Chemical Store Chepsito - KR",
  },
];

beforeEach(() => {
  fetchPlannedTransfers.mockReset().mockResolvedValue(RESP);
  fetchPlannedItems.mockReset().mockResolvedValue(ITEMS);
});

describe("the awaiting-approval section", () => {
  it("says on its face that nothing here can be issued yet", async () => {
    render(<PlannedChemicalsPanel />);
    expect(
      await screen.findByText(/Awaiting General Manager approval — view only/i),
    ).toBeInTheDocument();
  });

  it("is not interactive — no selection, no submit", async () => {
    // The whole point of the section. If a control ever appears here, a keeper
    // could try to issue chemicals against a plan the GM has not approved.
    const { container } = render(<PlannedChemicalsPanel />);
    await screen.findByText("MFG-WO-2026-05218");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /submit|issue|approve/i })).toBeNull();
  });

  it("shows each plan with the quantity it has asked for", async () => {
    render(<PlannedChemicalsPanel />);
    const row = (await screen.findByText("MFG-WO-2026-05218")).closest("tr")!;
    expect(within(row).getByText("2026-09-04")).toBeInTheDocument();
    expect(within(row).getByText("Chepsito")).toBeInTheDocument();
    expect(within(row).getByText("Chepsito GH 19 - KR")).toBeInTheDocument();
    expect(within(row).getByText("1.5")).toBeInTheDocument();
  });

  it("totals the demand per chemical above the table", async () => {
    render(<PlannedChemicalsPanel />);
    expect(await screen.findByText("IMPULSE EC500")).toBeInTheDocument();
    expect(screen.getByText("Litre")).toBeInTheDocument();
    expect(screen.getByText("1.1")).toBeInTheDocument();
  });

  it("fetches a plan's chemicals only when it is opened", async () => {
    const user = userEvent.setup();
    render(<PlannedChemicalsPanel />);
    const cell = await screen.findByText("MFG-WO-2026-05218");
    expect(fetchPlannedItems).not.toHaveBeenCalled();

    await user.click(cell);
    await waitFor(() => expect(fetchPlannedItems).toHaveBeenCalledWith("MFG-WO-2026-05218"));
    expect(await screen.findByText("Chemical Store Chepsito - KR")).toBeInTheDocument();
    expect(screen.getByText("Planned qty")).toBeInTheDocument();
  });

  it("does not re-fetch chemicals it has already loaded", async () => {
    const user = userEvent.setup();
    render(<PlannedChemicalsPanel />);
    const cell = await screen.findByText("MFG-WO-2026-05218");
    await user.click(cell);
    await waitFor(() => expect(fetchPlannedItems).toHaveBeenCalledTimes(1));
    await user.click(cell); // collapse
    await user.click(cell); // and open again
    expect(fetchPlannedItems).toHaveBeenCalledTimes(1);
  });

  it("passes the page's farm and date filters through to the server", async () => {
    render(
      <PlannedChemicalsPanel farm="Chepsito" fromDate="2026-09-01" toDate="2026-09-30" />,
    );
    await waitFor(() =>
      expect(fetchPlannedTransfers).toHaveBeenCalledWith({
        farm: "Chepsito",
        from_date: "2026-09-01",
        to_date: "2026-09-30",
      }),
    );
  });

  it("says the queue is empty rather than showing a blank table", async () => {
    fetchPlannedTransfers.mockResolvedValue({ ...RESP, rows: [], totals: [] });
    render(<PlannedChemicalsPanel />);
    expect(
      await screen.findByText(/No plans are waiting for approval/i),
    ).toBeInTheDocument();
  });

  it("reports a failure instead of pretending there is no demand", async () => {
    // `errorText` shows the server's own words when it has them — a generic
    // "failed to load" would be us talking over a message already aimed at
    // this user. The section must not fall silent and read as "no demand".
    fetchPlannedTransfers.mockRejectedValue(new Error("the site is restarting"));
    render(<PlannedChemicalsPanel />);
    expect(await screen.findByText(/the site is restarting/i)).toBeInTheDocument();
    expect(screen.queryByText(/No plans are waiting for approval/i)).toBeNull();
  });

  it("still shows the banner when the list fails to load", async () => {
    fetchPlannedTransfers.mockRejectedValue(new Error("boom"));
    render(<PlannedChemicalsPanel />);
    expect(
      await screen.findByText(/Awaiting General Manager approval/i),
    ).toBeInTheDocument();
  });
});
