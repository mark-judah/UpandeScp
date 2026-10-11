import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule as ScheduleData, SchedulePlan } from "@/lib/schedule-api";

const crew = (n: number, away: number) =>
  Array.from({ length: n }, (_, i) => ({
    employee: `E${i}`,
    name: `Person ${i}`,
    image: i === 0 ? "/files/p0.jpg" : "",
    role: i === 0 ? "Supervisor" : "Sprayer",
    status: (i < away ? (i === 0 ? "on_leave" : "leave_pending") : "ok") as "ok" | "on_leave" | "leave_pending",
  }));

const plan = (name: string, greenhouse: string, start: string, end: string, members: ReturnType<typeof crew>): SchedulePlan => ({
  name, greenhouse, farm: "Chepsito", team: "CSU 1", workflow_state: "Approved", spray_type: null,
  planned_start: `${start} 06:00:00`, actual_start: null, actual_end: null, start, end,
  crew: members.map((m) => ({ employee: m.employee, employee_name: m.name, role: m.role, status: m.status, half_day: false })),
  on_leave_count: members.filter((m) => m.status === "on_leave").length,
  pending_count: members.filter((m) => m.status === "leave_pending").length,
  crewAvailability: members,
  available_count: members.filter((m) => m.status === "ok").length,
});

const DATA: ScheduleData = {
  from_date: "2026-09-01", to_date: "2026-09-30", crop: "Rose", farms: ["Chepsito"], teams: ["CSU 1"],
  states: ["Approved"], latest_plan_date: "2026-09-08", leave_check: "Warn", leaves: [],
  plans: [
    plan("WO-SHORT", "Chepsito GH 16 - KR", "2026-09-02", "2026-09-05", crew(12, 3)),
    plan("WO-FULL", "Chepsito GH 17 - KR", "2026-09-08", "2026-09-08", crew(4, 0)),
  ],
};

vi.mock("@/lib/schedule-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/schedule-api")>()),
  fetchSchedule: vi.fn(async (args: { from_date: string }) =>
    args.from_date.startsWith("2026-09") ? DATA : { ...DATA, from_date: args.from_date, plans: [] },
  ),
}));

const { Schedule } = await import("@/pages/Schedule");

async function openSeptember() {
  render(<Schedule initialCrop="Rose" />);
  // Only September has plans; "Jump to latest plans" moves there from any month.
  const jump = await screen.findByRole("button", { name: /Jump to latest plans/ }).catch(() => null);
  if (jump) await userEvent.click(jump);
  await screen.findAllByTestId("cal-chip");
}

function noAccentStrips(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const cls = typeof el.className === "string" ? el.className : "";
    expect(cls, cls).not.toMatch(/(^|\s)(dark:)?border-l-(?!0\b)\S+/);
    expect(el.style.borderLeft || el.style.borderLeftWidth || "").toBe("");
  }
}

describe("Schedule crew availability (C2)", () => {
  beforeEach(() => window.localStorage.clear());

  it("calendar chips show the count, flag a short crew and open the crew popover", async () => {
    await openSeptember();
    const short = within(screen.getByTestId("cal-day-2026-09-02")).getByTestId("cal-chip");
    expect(short.getAttribute("data-unavailable")).toBe("true");
    expect(within(short).getByTestId("crew-count").textContent).toContain("9/12 available");
    const full = within(screen.getByTestId("cal-day-2026-09-08")).getByTestId("cal-chip");
    expect(full.getAttribute("data-unavailable")).toBeNull();
    expect(within(full).getByTestId("crew-count").textContent).toContain("4/4 available");

    await userEvent.click(within(short).getByTestId("crew-count"));
    const pop = await screen.findByTestId("crew-popover");
    const members = within(pop).getAllByTestId("crew-member");
    expect(members).toHaveLength(12);
    expect(members[0].getAttribute("data-status")).toBe("on_leave");
    expect(within(members[0]).getByText("On leave")).toBeTruthy();
    expect(within(members[0]).getByText("Supervisor")).toBeTruthy();
    expect(within(members[1]).getByText("Leave pending")).toBeTruthy();
    expect(within(members[5]).getByText("Available")).toBeTruthy();
    expect(pop.querySelector("img")?.getAttribute("src")).toBe("/files/p0.jpg");
  });

  it("Gantt bars show the count (compact on short bars) and open the same popover", async () => {
    await openSeptember();
    await userEvent.click(screen.getByRole("button", { name: "Gantt" }));
    const bars = await screen.findAllByTestId("gantt-bar");
    const short = bars.find((b) => b.getAttribute("title")?.startsWith("WO-SHORT"))!;
    const full = bars.find((b) => b.getAttribute("title")?.startsWith("WO-FULL"))!;
    expect(short.getAttribute("data-unavailable")).toBe("true");
    expect(within(short).getByTestId("crew-count").textContent).toBe("9/12 available");
    expect(within(full).getByTestId("crew-count").textContent).toBe("4/4");
    expect(within(full).getByTestId("crew-count").getAttribute("aria-label")).toBe("4 of 4 crew available");
    await userEvent.click(within(full).getByTestId("crew-count"));
    expect(within(await screen.findByTestId("crew-popover")).getAllByTestId("crew-member")).toHaveLength(4);
  });

  it("'Show unavailable only' keeps only plans with someone unavailable, in both views", async () => {
    await openSeptember();
    expect(screen.getAllByTestId("cal-chip")).toHaveLength(2);
    await userEvent.click(screen.getByTestId("unavailable-only"));
    await waitFor(() => expect(screen.getAllByTestId("cal-chip")).toHaveLength(1));
    expect(screen.getByTestId("cal-chip").getAttribute("data-unavailable")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Gantt" }));
    expect(await screen.findAllByTestId("gantt-bar")).toHaveLength(1);
    expect(window.localStorage.getItem("scp.schedule.unavailableOnly")).toBe("1");
  });

  it("no left-border accent strips on chips, bars or the popover", async () => {
    await openSeptember();
    noAccentStrips(document.body);
    await userEvent.click(screen.getByRole("button", { name: "Gantt" }));
    await screen.findAllByTestId("gantt-bar");
    await userEvent.click(within(screen.getAllByTestId("gantt-bar")[0]).getByTestId("crew-count"));
    await screen.findByTestId("crew-popover");
    noAccentStrips(document.body);
  });
});
