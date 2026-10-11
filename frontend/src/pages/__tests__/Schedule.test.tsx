import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule as ScheduleData } from "@/lib/schedule-api";
import { monthRange } from "@/components/schedule/schedule-utils";

const THIS_MONTH = monthRange(new Date());

const FULL: ScheduleData = {
  from_date: "2026-09-01",
  to_date: "2026-09-30",
  crop: "Rose",
  farms: ["Chepsito"],
  teams: ["CSU 1", "CSU 2"],
  states: ["Completed", "Approved"],
  latest_plan_date: "2026-09-06",
  leave_check: "Warn",
  plans: [
    {
      name: "WO-1", greenhouse: "Chepsito GH 16 - KR", farm: "Chepsito", team: "CSU 1",
      workflow_state: "Completed", spray_type: null, planned_start: "2026-09-02 18:10:00",
      actual_start: null, actual_end: "2026-09-03 01:05:00", start: "2026-09-02", end: "2026-09-03",
      crew: [{ employee: "E1", employee_name: "Alice", role: "Sprayer", status: "on_leave", half_day: false }],
      on_leave_count: 1, pending_count: 0,
    },
    {
      name: "WO-2", greenhouse: "Chepsito GH 17 - KR", farm: "Chepsito", team: "CSU 2",
      workflow_state: "Approved", spray_type: null, planned_start: "2026-09-04 06:00:00",
      actual_start: null, actual_end: null, start: "2026-09-04", end: "2026-09-04",
      crew: [], on_leave_count: 0, pending_count: 0,
    },
  ],
  leaves: [
    {
      name: "HR-LAP-1", employee: "E1", employee_name: "Alice", leave_type: "Annual Leave",
      from_date: "2026-09-01", to_date: "2026-09-05", half_day: false, status: "approved", teams: ["CSU 1"],
    },
  ],
};

const EMPTY: ScheduleData = { ...FULL, from_date: THIS_MONTH.from, to_date: THIS_MONTH.to, plans: [], leaves: [] };

const fetchMock = vi.fn(async (args: { from_date: string }) =>
  args.from_date.startsWith("2026-09") ? FULL : EMPTY,
);

vi.mock("@/lib/schedule-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/schedule-api")>()),
  fetchSchedule: (args: { from_date: string }) => fetchMock(args),
}));

const { Schedule } = await import("@/pages/Schedule");

describe("Schedule page", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    window.localStorage.clear();
  });

  it("jumps to the newest month with plans when the range is empty", async () => {
    render(<Schedule initialCrop="Rose" />);
    const jump = await screen.findByRole("button", { name: /Jump to latest plans/ });
    await userEvent.click(jump);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ from_date: "2026-09-01", to_date: "2026-09-30" }),
      ),
    );
    expect(await screen.findByTestId("schedule-calendar")).toBeTruthy();
  });

  it("calendar lists plans on their day with a leave warning", async () => {
    render(<Schedule initialCrop="Rose" />);
    await userEvent.click(await screen.findByRole("button", { name: /Jump to latest plans/ }));
    const cell = await screen.findByTestId("cal-day-2026-09-02");
    expect(within(cell).getByText("GH 16")).toBeTruthy();
    expect(within(cell).getByTestId("leave-warning").textContent).toContain("1");
    const other = screen.getByTestId("cal-day-2026-09-04");
    expect(within(other).queryByTestId("leave-warning")).toBeNull();
  });

  it("the toggle switches to the Gantt, remembers it, and team rows show leave bars", async () => {
    render(<Schedule initialCrop="Rose" />);
    await userEvent.click(await screen.findByRole("button", { name: /Jump to latest plans/ }));
    await screen.findByTestId("schedule-calendar");

    await userEvent.click(screen.getByRole("button", { name: "Gantt" }));
    expect(await screen.findByTestId("schedule-gantt")).toBeTruthy();
    expect(screen.queryByTestId("schedule-calendar")).toBeNull();
    expect(window.localStorage.getItem("scp.schedule.view")).toBe("gantt");
    expect(screen.getAllByTestId("gantt-bar")).toHaveLength(2);
    // greenhouse rows: no leave bars
    expect(screen.queryAllByTestId("gantt-leave")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Teams" }));
    const leave = await screen.findByTestId("gantt-leave");
    expect(leave.textContent).toContain("Alice");
    expect(leave.getAttribute("data-status")).toBe("approved");
    // the two-day plan spans two columns (grid lines 3 → 5 for days 2–3 of the month)
    const bar = screen.getAllByTestId("gantt-bar").find((b) => b.getAttribute("title")?.startsWith("WO-1"))!;
    expect(bar.style.gridColumn).toBe("3 / 5");
  });

  it("opens with the remembered view", async () => {
    window.localStorage.setItem("scp.schedule.view", "gantt");
    render(<Schedule initialCrop="Rose" />);
    await userEvent.click(await screen.findByRole("button", { name: /Jump to latest plans/ }));
    expect(await screen.findByTestId("schedule-gantt")).toBeTruthy();
  });
});
