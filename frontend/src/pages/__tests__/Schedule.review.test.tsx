/**
 * Review fixes on the Schedule page: the range clamp note (R4), team options that
 * survive a team filter (R5), stale responses dropped and plans that run into the
 * range from before it (R6).
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select needs these in jsdom.
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
import type { Schedule as ScheduleData, SchedulePlan } from "@/lib/schedule-api";
import { ScheduleCalendar } from "@/components/schedule/ScheduleCalendar";
import { ScheduleGantt } from "@/components/schedule/ScheduleGantt";
import { addMonths } from "date-fns";
import { calendarDayOf, monthRange } from "@/components/schedule/schedule-utils";

const NOW = monthRange(new Date());
const NEXT = monthRange(addMonths(new Date(), 1));

const plan = (over: Partial<SchedulePlan>): SchedulePlan => ({
  name: "WO-1", greenhouse: "Chepsito GH 16 - KR", farm: "Chepsito", team: "CSU 1",
  workflow_state: "Approved", spray_type: null, planned_start: null, actual_start: null,
  actual_end: null, start: "2026-09-02", end: "2026-09-02", crew: [], on_leave_count: 0,
  pending_count: 0, ...over,
});

const base = (over: Partial<ScheduleData>): ScheduleData => ({
  from_date: "2026-09-01", to_date: "2026-09-30", crop: "Rose", farms: ["Chepsito"],
  teams: ["CSU 1", "CSU 2"], states: [], latest_plan_date: null, leave_check: "Warn",
  plans: [plan({}), plan({ name: "WO-2", team: "CSU 2" })], leaves: [], ...over,
});

type Args = { from_date: string; to_date: string; team?: string };
const fetchMock = vi.fn(async (_args: Args): Promise<ScheduleData> => base({}));

vi.mock("@/lib/schedule-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/schedule-api")>()),
  fetchSchedule: (args: Args) => fetchMock(args),
}));

const { Schedule } = await import("@/pages/Schedule");

describe("Schedule review fixes", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => base({}));
    window.localStorage.clear();
  });

  it("R4: says so when the server clamped the range", async () => {
    fetchMock.mockImplementation(async () =>
      base({ clamped: true, from_date: "2026-06-29", to_date: "2026-09-30", max_range_days: 93 }),
    );
    render(<Schedule initialCrop="Rose" />);
    const note = await screen.findByTestId("schedule-clamped");
    expect(note.textContent).toContain("2026-06-29");
    expect(note.textContent).toContain("93 days");
  });

  it("R5: picking a team keeps the other teams on offer", async () => {
    fetchMock.mockImplementation(async (a: Args) =>
      a.team
        ? base({ teams: [a.team], plans: [plan({ team: a.team, start: NOW.from, end: NOW.from })] }) // a filtered payload
        : base({ plans: [plan({ start: NOW.from, end: NOW.from }), plan({ name: "WO-2", team: "CSU 2", start: NOW.from, end: NOW.from })] }),
    );
    render(<Schedule initialCrop="Rose" />);
    // The pill dropdown (FilterSelect): open it, read its options, pick one.
    const trigger = await screen.findByRole("combobox", { name: "Team" });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("option", { name: "CSU 1" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ team: "CSU 1" })),
    );
    await waitFor(() => expect(screen.getAllByTestId("cal-chip")).toHaveLength(1));
    await userEvent.click(screen.getByRole("combobox", { name: "Team" }));
    const names = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(names).toEqual(["All teams", "CSU 1", "CSU 2"]);
  });

  it("R6: a slow earlier response never overwrites a newer one", async () => {
    let releaseFirst: (d: ScheduleData) => void = () => {};
    fetchMock
      .mockImplementationOnce(() => new Promise<ScheduleData>((res) => { releaseFirst = res; }))
      .mockImplementation(async () => base({ plans: [plan({ name: "WO-NEW", greenhouse: "Chepsito GH 99 - KR", start: NEXT.from, end: NEXT.from })] }));
    render(<Schedule initialCrop="Rose" />);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("GH 99");
    await act(async () => {
      releaseFirst(base({ plans: [plan({ name: "WO-OLD", greenhouse: "Chepsito GH 11 - KR", start: NEXT.from, end: NEXT.from })] }));
    });
    expect(screen.queryByText("GH 11")).toBeNull();
    expect(screen.getByText("GH 99")).toBeTruthy();
  });
});

describe("plans that began before the visible range (R6)", () => {
  const running = plan({ name: "WO-RUN", start: "2026-08-30", end: "2026-09-02" });
  const over = plan({ name: "WO-DONE", start: "2026-08-20", end: "2026-08-25" });

  it("calendarDayOf puts a running plan on the first visible day", () => {
    expect(calendarDayOf(running, "2026-09-01")).toBe("2026-09-01");
    expect(calendarDayOf(over, "2026-09-01")).toBeNull();
    expect(calendarDayOf(plan({}), "2026-09-01")).toBe("2026-09-02");
  });

  it("calendar shows it on the first visible day with a continues marker", () => {
    render(<ScheduleCalendar plans={[running]} from="2026-09-01" to="2026-09-30" onOpen={() => {}} />);
    const cell = screen.getByTestId("cal-day-2026-09-01");
    expect(within(cell).getByTestId("cal-chip")).toBeTruthy();
    expect(within(cell).getByTestId("cal-continues")).toBeTruthy();
    expect(within(screen.getByTestId("cal-day-2026-08-31")).queryByTestId("cal-chip")).toBeNull();
  });

  it("Gantt clips the bar at the left edge", () => {
    render(
      <ScheduleGantt plans={[running, plan({ name: "WO-IN" })]} leaves={[]} from="2026-09-01" to="2026-09-30"
        rowsBy="team" onOpen={() => {}} />,
    );
    const bars = screen.getAllByTestId("gantt-bar");
    const clipped = bars.find((b) => b.getAttribute("title")?.startsWith("WO-RUN"))!;
    expect(clipped.getAttribute("data-clipped")).toBe("start");
    expect(clipped.style.gridColumn).toBe("2 / 4"); // Sep 1 → Sep 2
    const inside = bars.find((b) => b.getAttribute("title")?.startsWith("WO-IN"))!;
    expect(inside.getAttribute("data-clipped")).toBeNull();
  });
});
