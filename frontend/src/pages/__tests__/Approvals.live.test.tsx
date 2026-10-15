/**
 * Live approvals: a `scp:spray_plan` event re-reads the list; the new plan gets
 * a "New" pill and a toast, and the approver's ticked plan stays ticked.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wo = (name: string) => ({
  name, custom_greenhouse: "GH 1", custom_scheduled_application_time: "2026-10-15 08:00:00",
  planned_start_date: "2026-10-15", required_items: [], is_forwarded: false, farm: "Karen",
});
const fetchPending = vi.fn();
vi.mock("@/lib/spray-plan-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-plan-api")>()),
  fetchFarmsAndGreenhouses: () => Promise.resolve({ farms: ["Karen"], greenhouses_by_farm: {} }),
  fetchPendingWorkOrders: (...a: unknown[]) => fetchPending(...a),
}));
vi.mock("@/lib/lifecycle-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/lifecycle-api")>()),
  fetchLifecycleSummary: () => Promise.resolve([]),
}));
const show = vi.fn();
vi.mock("@/components/Toast", async (orig) => ({
  ...(await orig<typeof import("@/components/Toast")>()),
  useToast: () => ({ show, dismiss: () => {} }),
}));
vi.mock("@/lib/utils", async (orig) => ({
  ...(await orig<typeof import("@/lib/utils")>()),
  ymd: () => "2026-10-15",
}));

const { Approvals } = await import("@/pages/Approvals");

let handlers: Record<string, (d: unknown) => void> = {};
beforeEach(() => {
  handlers = {};
  show.mockReset();
  fetchPending.mockReset();
  (window as any).frappe = {
    realtime: {
      connected: true,
      on: (ev: string, cb: (d: unknown) => void) => { handlers[ev] = cb; },
      off: () => {},
    },
  };
});

describe("Approvals live updates", () => {
  it("adds a new plan with a New pill and toast, keeping the selection", async () => {
    fetchPending.mockResolvedValueOnce({ work_orders: [wo("WO-A")] });
    render(<Approvals initialCrop="Rose" />);
    await screen.findByText("WO-A");
    await userEvent.click(screen.getByLabelText("Select WO-A"));
    expect(screen.getByText("1")).toBeInTheDocument();

    fetchPending.mockResolvedValueOnce({ work_orders: [wo("WO-B"), wo("WO-A")] });
    // An event for another day is ignored.
    act(() => handlers["scp:spray_plan"]({ name: "X", date: "2026-11-01", created: "2026-11-01", farm: "Karen", greenhouse: "GH 1" }));
    await new Promise((r) => setTimeout(r, 600));
    expect(fetchPending).toHaveBeenCalledTimes(1);

    act(() => handlers["scp:spray_plan"]({ name: "WO-B", date: "2026-10-15", created: "2026-10-15", farm: "Karen", greenhouse: "GH 1" }));
    await screen.findByText("WO-B");
    expect(screen.getAllByTestId("new-pill")).toHaveLength(1);
    expect(show).toHaveBeenCalledWith("1 new plan for 15 Oct", "info");
    expect(screen.getByLabelText("Select WO-A")).toBeChecked();
    expect(screen.getByLabelText("Select WO-B")).not.toBeChecked();

    // Looking at the plan clears its pill.
    await userEvent.click(screen.getByLabelText("Select WO-B"));
    await waitFor(() => expect(screen.queryByTestId("new-pill")).toBeNull());
  });
});
