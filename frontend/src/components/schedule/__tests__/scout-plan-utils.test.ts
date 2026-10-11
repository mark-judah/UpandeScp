import { describe, expect, it } from "vitest";
import { addAssignment, copyLastWeek, leaveNote, statusFor, unplannedActuals, weeklyCheck } from "../scout-plan-utils";

const r = (date: string, scout: string, greenhouse: string) => ({ date, scout, greenhouse });

describe("scout plan rules", () => {
  it("approved leave refuses, pending warns, repeats are a no-op", () => {
    const leaves = { S1: { "2026-10-06": "on_leave" as const, "2026-10-07": "leave_pending" as const } };
    expect(addAssignment([], r("2026-10-06", "S1", "GH1"), leaves, "Ann").error).toMatch(/Ann is on approved leave/);
    const pending = addAssignment([], r("2026-10-07", "S1", "GH1"), leaves);
    expect(pending.rows).toHaveLength(1);
    expect(pending.warning).toMatch(/pending/);
    const again = addAssignment(pending.rows, r("2026-10-07", "S1", "GH1"), leaves);
    expect(again.rows).toBe(pending.rows);
  });

  it("copies last week's plan seven days on, else its actuals, skipping leave", () => {
    const base = { greenhouses: ["GH1", "GH2"], leaves: { S2: { "2026-10-06": "on_leave" as const } } };
    const fromPlan = copyLastWeek({ ...base, lastWeek: { assignments: [r("2026-09-28", "S1", "GH1")], actuals: [] } });
    expect(fromPlan).toEqual({ rows: [r("2026-10-05", "S1", "GH1")], source: "plan", skippedLeave: 0 });
    const fromActuals = copyLastWeek({
      ...base,
      lastWeek: {
        assignments: [],
        actuals: [
          { ...r("2026-09-29", "S2", "GH2"), entries: 9 },
          { ...r("2026-09-30", "S1", "GH9"), entries: 9 }, // not this farm's house
          { ...r("2026-09-30", "S1", "GH2"), entries: 3 },
        ],
      },
    });
    expect(fromActuals.source).toBe("actuals");
    expect(fromActuals.rows).toEqual([r("2026-10-07", "S1", "GH2")]);
    expect(fromActuals.skippedLeave).toBe(1);
  });

  it("Done / Missed / Planned and unplanned scouting", () => {
    const actuals = [{ ...r("2026-10-05", "S1", "GH1"), entries: 30 }, { ...r("2026-10-05", "S2", "GH2"), entries: 4 }];
    expect(statusFor(r("2026-10-05", "S1", "GH1"), actuals, "2026-10-08")).toBe("Done");
    expect(statusFor(r("2026-10-06", "S1", "GH1"), actuals, "2026-10-08")).toBe("Missed");
    expect(statusFor(r("2026-10-08", "S1", "GH1"), actuals, "2026-10-08")).toBe("Planned");
    expect(unplannedActuals(actuals, [r("2026-10-05", "S1", "GH1")])).toEqual([actuals[1]]);
  });

  it("weekly check mirrors the server rules", () => {
    const rows = [
      ...["05", "06", "07", "08", "09"].map((d) => r(`2026-10-${d}`, "S1", "GH1")),
      r("2026-10-05", "S2", "GH2"),
      r("2026-10-06", "S2", "GH2"),
      r("2026-10-05", "S3", "GH2"),
      r("2026-10-06", "S3", "GH2"),
      r("2026-10-07", "S3", "GH2"),
    ];
    const out = weeklyCheck(["GH1", "GH2", "GH3"], rows, [{ date: "2026-10-05", scout: "S1", farm: "Torongo" }], "Chepsito");
    expect(out.unplanned).toEqual(["GH3"]);
    expect(out.median).toBe(3);
    expect(out.load.find((l) => l.scout === "S1")).toMatchObject({ houseDays: 5, flag: "high" });
    expect(out.load.find((l) => l.scout === "S2")?.flag).toBeNull();
    expect(out.conflicts).toEqual([{ scout: "S1", date: "2026-10-05", farms: ["Chepsito", "Torongo"] }]);
  });

  it("C9: On leave beats Missed, the check lists them, and the leave note collapses runs", () => {
    const leaves = { S1: { "2026-10-06": "on_leave" as const } };
    expect(statusFor(r("2026-10-06", "S1", "GH1"), [], "2026-10-08", leaves)).toBe("On leave");
    expect(statusFor(r("2026-10-06", "S1", "GH1"), [{ ...r("2026-10-06", "S1", "GH1"), entries: 2 }], "2026-10-08", leaves)).toBe("Done");
    const out = weeklyCheck(["GH1"], [r("2026-10-06", "S1", "GH1"), r("2026-10-07", "S1", "GH1")], [], "F", leaves);
    expect(out.onLeave).toEqual([r("2026-10-06", "S1", "GH1")]);
    const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
    expect(leaveNote(days, { "2026-10-06": "on_leave", "2026-10-07": "on_leave", "2026-10-08": "on_leave", "2026-10-10": "on_leave", "2026-10-05": "leave_pending" }))
      .toBe("Leave Tue–Thu, Sat · Pending Mon");
    expect(leaveNote(days, undefined)).toBe("");
  });
});
