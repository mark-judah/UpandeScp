import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRow, ScoutPlan } from "@/lib/scout-plan-api";

const DAYS = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const GH = ["Chepsito GH 01 - KR", "Chepsito GH 02 - KR", "Chepsito GH 03 - KR"];

const PLAN = (over: Partial<ScoutPlan> = {}): ScoutPlan => ({
  crop: "Rose", farm: "Chepsito", farms: ["Chepsito", "Torongo"],
  weekStart: DAYS[0], weekEnd: DAYS[6], days: DAYS, today: "2026-10-08", canEdit: true,
  greenhouses: GH,
  scouts: [
    { scout: "S1", name: "Ann Kibet", image: "/files/s1.jpg", user: "ann@x", entries: 400, active: true },
    { scout: "S2", name: "Ben Otieno", image: "", user: null, entries: 300, active: true },
  ],
  assignments: [{ name: "a1", date: DAYS[0], scout: "S1", greenhouse: GH[0], scoutName: "Ann Kibet", status: "Done" }],
  actuals: [
    { date: DAYS[0], scout: "S1", greenhouse: GH[0], entries: 40 },
    { date: DAYS[1], scout: "S2", greenhouse: GH[2], entries: 12 },
  ],
  unplanned: [{ date: DAYS[1], scout: "S2", greenhouse: GH[2], entries: 12 }],
  lastWeek: {
    assignments: [],
    actuals: [
      { date: "2026-09-29", scout: "S1", greenhouse: GH[1], entries: 30 },
      { date: "2026-09-30", scout: "S2", greenhouse: GH[2], entries: 30 }, // S2 is on leave the 7th
    ],
  },
  leaves: { S2: { [DAYS[2]]: "on_leave" }, S1: { [DAYS[4]]: "leave_pending" } },
  elsewhere: [],
  check: { unplanned: [GH[1], GH[2]], median: 1, load: [], conflicts: [], onLeave: [] },
  ...over,
});

const fetchMock = vi.fn(async (_a: unknown) => PLAN());
const saveMock = vi.fn(async (a: { assignments: PlanRow[] }) =>
  PLAN({ assignments: a.assignments.map((r) => ({ ...r })), saved: a.assignments.length, warnings: [] }),
);
vi.mock("@/lib/scout-plan-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scout-plan-api")>()),
  fetchScoutPlan: (a: unknown) => fetchMock(a),
  saveScoutPlan: (a: { assignments: PlanRow[] }) => saveMock(a),
}));

const { ScoutPlanView } = await import("../ScoutPlanView");
const cell = (gh: string, d: string) => screen.getByTestId(`scout-cell-${gh}-${d}`);
const picker = (name: string) =>
  within(screen.getByTestId("scout-picker")).getAllByTestId("picker-item").find((b) => b.textContent?.includes(name))!;

describe("Scout plan grid (C4–C6)", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    saveMock.mockClear();
  });

  it("shows Done on a past planned day and unplanned scouting as a faint outlined chip", async () => {
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    const done = within(await screen.findByTestId(`scout-cell-${GH[0]}-${DAYS[0]}`)).getByTestId("plan-chip");
    expect(done.getAttribute("data-status")).toBe("Done");
    expect(done.querySelector("img")?.getAttribute("src")).toBe("/files/s1.jpg");
    expect(within(cell(GH[2], DAYS[1])).getByTestId("unplanned-chip").textContent).toContain("Ben");
    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({ week_start: "2026-10-05" }));
  });

  it("assigns by picking a scout and clicking a cell, removes by clicking the chip, and saves", async () => {
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    await userEvent.click(picker("Ann"));
    await userEvent.click(cell(GH[1], DAYS[3]));
    const chip = within(cell(GH[1], DAYS[3])).getByTestId("plan-chip");
    expect(chip.getAttribute("data-status")).toBe("Planned");
    // a past day with no entries is Missed
    await userEvent.click(cell(GH[1], DAYS[1]));
    expect(within(cell(GH[1], DAYS[1])).getByTestId("plan-chip").getAttribute("data-status")).toBe("Missed");
    await userEvent.click(within(cell(GH[1], DAYS[1])).getByTestId("plan-chip"));
    expect(within(cell(GH[1], DAYS[1])).queryByTestId("plan-chip")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const sent = saveMock.mock.calls[0][0].assignments.map((r) => `${r.date}|${r.scout}|${r.greenhouse}`).sort();
    expect(sent).toEqual([`${DAYS[0]}|S1|${GH[0]}`, `${DAYS[3]}|S1|${GH[1]}`]);
    expect(await screen.findByTestId("scout-note")).toBeTruthy();
  });

  it("assigns from the keyboard: a picked scout lands on a focused cell with Enter", async () => {
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    await userEvent.click(picker("Ann"));
    const target = cell(GH[1], DAYS[3]);
    expect(target.getAttribute("role")).toBe("button");
    expect(target.getAttribute("aria-label")).toMatch(/^Assign /);
    target.focus();
    await userEvent.keyboard("{Enter}");
    expect(within(target).getByTestId("plan-chip").getAttribute("data-status")).toBe("Planned");
  });

  it("greys a scout on approved leave and refuses the drop; pending leave only warns", async () => {
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    // focus Wednesday the 7th: Ben is on leave that day
    await userEvent.click(screen.getByRole("button", { name: /Wed 7/ }));
    expect(picker("Ben").getAttribute("data-leave")).toBe("on_leave");
    expect(picker("Ben").className).toMatch(/opacity-45/);
    await userEvent.click(picker("Ben"));
    expect(cell(GH[0], DAYS[2]).getAttribute("data-blocked")).toBe("true");
    await userEvent.click(cell(GH[0], DAYS[2]));
    expect(within(cell(GH[0], DAYS[2])).queryByTestId("plan-chip")).toBeNull();
    expect((await screen.findByTestId("scout-note")).textContent).toMatch(/Ben Otieno is on approved leave/);

    await userEvent.click(picker("Ann"));
    await userEvent.click(cell(GH[0], DAYS[4]));
    expect(within(cell(GH[0], DAYS[4])).getByTestId("plan-chip")).toBeTruthy();
    expect(screen.getByTestId("scout-note").textContent).toMatch(/pending/);
  });

  it("copy last week (from actuals, skipping leave) and clear week", async () => {
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    await userEvent.click(screen.getByRole("button", { name: /Copy last week/ }));
    expect(within(cell(GH[1], DAYS[1])).getByTestId("plan-chip").textContent).toContain("Ann");
    expect(within(cell(GH[2], DAYS[2])).queryByTestId("plan-chip")).toBeNull();
    expect(screen.getByTestId("scout-note").textContent).toMatch(/1 skipped: approved leave/);
    await userEvent.click(screen.getByRole("button", { name: /Clear week/ }));
    expect(screen.queryAllByTestId("plan-chip")).toHaveLength(0);
    // the weekly check follows the draft
    expect(within(screen.getByTestId("check-unplanned")).getAllByText(/GH 0/)).toHaveLength(3);
  });

  it("C9: leave approved after saving shows On leave (not Missed) and asks to reassign", async () => {
    fetchMock.mockImplementationOnce(async () =>
      PLAN({
        assignments: [
          { date: DAYS[0], scout: "S1", greenhouse: GH[0], status: "Done" },
          { date: DAYS[2], scout: "S2", greenhouse: GH[1], status: "On leave" },
          { date: DAYS[1], scout: "S1", greenhouse: GH[1], status: "Missed" },
        ],
      }),
    );
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    const away = within(cell(GH[1], DAYS[2])).getByTestId("plan-chip");
    expect(away.getAttribute("data-status")).toBe("On leave");
    expect(away.textContent).toContain("On leave");
    expect(within(cell(GH[1], DAYS[1])).getByTestId("plan-chip").getAttribute("data-status")).toBe("Missed");
    const box = screen.getByTestId("check-on-leave");
    expect(box.textContent).toMatch(/Planned scouts now on leave — reassign \(1\)/);
    expect(box.textContent).toMatch(/Ben Otieno · Wed 7 · Chepsito GH 02/);
  });

  it("C9: the picker notes each scout's leave days in the week", async () => {
    fetchMock.mockImplementationOnce(async () =>
      PLAN({ leaves: { S2: { [DAYS[1]]: "on_leave", [DAYS[2]]: "on_leave", [DAYS[3]]: "on_leave" }, S1: { [DAYS[4]]: "leave_pending" } } }),
    );
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    expect(within(picker("Ben")).getByTestId("picker-leave-note").textContent).toBe("Leave Tue–Thu");
    expect(within(picker("Ann")).getByTestId("picker-leave-note").textContent).toBe("Pending Fri");
  });

  it("flips to scout rows", async () => {
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    await userEvent.click(screen.getByRole("button", { name: "Scout rows" }));
    expect(within(cell("S1", DAYS[0])).getByTestId("plan-chip").textContent).toContain("Chepsito GH 01");
  });

  it("is read-only for users who do not manage the farm, and has no accent strips", async () => {
    fetchMock.mockImplementationOnce(async () => PLAN({ canEdit: false }));
    render(<ScoutPlanView crop="Rose" initialWeek="2026-10-08" />);
    await screen.findByTestId("scout-grid");
    expect(screen.queryByTestId("scout-picker")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(within(cell(GH[0], DAYS[0])).getByTestId("plan-chip")).toHaveProperty("disabled", true);
    for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
      const cls = typeof el.className === "string" ? el.className : "";
      expect(cls).not.toMatch(/(^|\s)(dark:)?border-l-(?!0\b)\S+/);
    }
  });
});
