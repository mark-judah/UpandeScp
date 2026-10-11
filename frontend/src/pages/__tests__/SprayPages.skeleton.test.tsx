/**
 * In-place skeletons (spec 2026-10-11) for the spray pages: while the data
 * promise is pending the page's real frame — title, tabs, table headings — is
 * already on screen and only the data slots pulse; once it resolves the
 * skeletons are gone.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const skeletonRows = (root: ParentNode = document) =>
  root.querySelectorAll('[data-skeleton="row"]');

// ── Approvals ───────────────────────────────────────────────────────────
const pendingWos = deferred<{ work_orders: unknown[] }>();
vi.mock("@/lib/spray-plan-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spray-plan-api")>()),
  fetchFarmsAndGreenhouses: () => Promise.resolve({ farms: ["Chepsito"], greenhouses_by_farm: {} }),
  fetchPendingWorkOrders: () => pendingWos.promise,
}));
vi.mock("@/lib/lifecycle-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/lifecycle-api")>()),
  fetchLifecycleSummary: () => Promise.resolve([]),
}));

// ── TankMixes ───────────────────────────────────────────────────────────
const tankMixes = deferred<{ tank_mixes: unknown[]; farms: string[] }>();
vi.mock("@/lib/frappe", async (orig) => ({
  ...(await orig<typeof import("@/lib/frappe")>()),
  call: () => tankMixes.promise,
}));

// ── Schedule ────────────────────────────────────────────────────────────
const schedule = deferred<unknown>();
vi.mock("@/lib/schedule-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/schedule-api")>()),
  fetchSchedule: () => schedule.promise,
}));

const { Approvals } = await import("@/pages/Approvals");
const { TankMixes } = await import("@/pages/TankMixes");
const { Schedule } = await import("@/pages/Schedule");

describe("spray pages draw their frame while the data loads", () => {
  it("Approvals: title, tabs and table headings stand; rows pulse until the list lands", async () => {
    render(<Approvals />);
    expect(screen.getByText("Spray Plan Approval")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Pending/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Forwarded/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Work Order" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Greenhouse" })).toBeInTheDocument();
    expect(skeletonRows().length).toBeGreaterThan(0);
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    // no empty-state wording while loading
    expect(screen.queryByText(/No pending spray plans/)).toBeNull();

    pendingWos.resolve({
      work_orders: [
        {
          name: "MFG-WO-0001",
          custom_greenhouse: "Chepsito GH 16",
          custom_scheduled_application_time: "2026-10-11 06:00:00",
          required_items: [],
          is_forwarded: false,
        },
      ],
    });
    expect(await screen.findByText("MFG-WO-0001")).toBeInTheDocument();
    await waitFor(() => expect(skeletonRows()).toHaveLength(0));
    expect(screen.getByRole("tab", { name: /Pending · 1/ })).toBeInTheDocument();
  });

  it("TankMixes: header and filters stand; skeleton cards keep the stat labels and table headings", async () => {
    render(<TankMixes />);
    expect(screen.getByText("Tank Mixes")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toBeInTheDocument();
    const cards = document.querySelectorAll('[data-skeleton="card"]');
    expect(cards.length).toBeGreaterThan(0);
    expect(screen.getAllByText("Water pH").length).toBe(cards.length);
    expect(screen.getAllByRole("columnheader", { name: "Chemical" }).length).toBe(cards.length);
    expect(skeletonRows().length).toBeGreaterThan(0);
    expect(screen.queryByText("No tank mixes match")).toBeNull();

    tankMixes.resolve({ tank_mixes: [], farms: [] });
    expect(await screen.findByText("No tank mixes match")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-skeleton="card"]')).toHaveLength(0);
    expect(skeletonRows()).toHaveLength(0);
  });

  it("Schedule: view toggle, filters and legend stand; the calendar grid pulses", async () => {
    window.localStorage.clear();
    render(<Schedule initialCrop="Rose" />);
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "State" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Farm" })).toBeDisabled();
    expect(screen.getByText("Show unavailable only")).toBeInTheDocument();
    const cal = screen.getByTestId("schedule-calendar");
    expect(cal).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Mon")).toBeInTheDocument();
    expect(screen.queryByText("No spray plans in this range.")).toBeNull();

    schedule.resolve({
      from_date: "2026-10-01",
      to_date: "2026-10-31",
      crop: "Rose",
      farms: ["Chepsito"],
      teams: [],
      states: [],
      latest_plan_date: null,
      leave_check: "Warn",
      plans: [],
      leaves: [],
    });
    expect(await screen.findByText("No spray plans in this range.")).toBeInTheDocument();
    expect(screen.queryByTestId("schedule-calendar")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Farm" })).not.toBeDisabled();
  });
});
