/**
 * The pure helpers behind the postponement page.
 *
 * `describeDeadline` carries the distinction the whole screen turns on: past the
 * cutoff is not one state but two, and the middle one — spray off, postponement still
 * possible — is the case a supervisor most needs told, because the alternative is the
 * plan being left until auto-cancel stops it.
 */
import { describe, expect, it } from "vitest";
import {
  describeDeadline,
  latestAllowed,
  shortTime,
  summarisePostponement,
  type Postponement,
  type PostponablePlan,
} from "./postponement-api";

const plan = (over: Partial<PostponablePlan> = {}): PostponablePlan => ({
  work_order: "MFG-WO-2026-05200",
  state: "Approved",
  greenhouse: "GH 12",
  farm: "Kaptumbo",
  scheduled: "2026-08-17 06:00:00",
  deadline: "2026-08-17 10:00:00",
  past_cutoff: false,
  can_postpone: true,
  request_pending: false,
  ...over,
});

describe("describeDeadline", () => {
  it("says how long is left while the plan is still in time", () => {
    const d = describeDeadline(plan());
    expect(d.tone).toBe("ok");
    expect(d.text).toContain("2026-08-17 10:00:00");
  });

  it("distinguishes past-cutoff-but-postponable from past-everything", () => {
    const inGrace = describeDeadline(
      plan({ past_cutoff: true, can_postpone: true }),
    );
    expect(inGrace.tone).toBe("warn");
    expect(inGrace.text).toContain("can still be postponed");

    const gone = describeDeadline(
      plan({ past_cutoff: true, can_postpone: false }),
    );
    expect(gone.tone).toBe("gone");
    expect(gone.text).toContain("General Manager");
  });

  it("does not call an unscheduled plan late", () => {
    const d = describeDeadline(plan({ scheduled: null, deadline: null }));
    expect(d.tone).toBe("ok");
    expect(d.text).toBe("no scheduled date");
  });
});

describe("latestAllowed", () => {
  it("adds the bound to the plan's own date", () => {
    expect(latestAllowed("2026-08-17 06:00:00", 7)).toBe("2026-08-24");
  });

  it("counts from today when the plan has no date", () => {
    expect(latestAllowed(null, 0)).toBe(new Date().toISOString().slice(0, 10));
  });

  it("treats a negative bound as zero rather than moving backwards", () => {
    expect(latestAllowed("2026-08-17", -5)).toBe("2026-08-17");
  });

  it("returns empty on an unparseable date instead of NaN", () => {
    expect(latestAllowed("not a date", 7)).toBe("");
  });
});

describe("shortTime", () => {
  it("drops the seconds, which are noise on a deadline", () => {
    expect(shortTime("10:00:00")).toBe("10:00");
    expect(shortTime("07:45:00")).toBe("07:45");
  });

  it("survives a blank", () => {
    expect(shortTime(null)).toBe("");
    expect(shortTime(undefined)).toBe("");
  });
});

describe("summarisePostponement", () => {
  const base: Postponement = {
    name: "SPP-2026-00001",
    work_order: "MFG-WO-2026-05200",
    farm: "Kaptumbo",
    greenhouse: "GH 12",
    state_at_declaration: "Approved",
    from_datetime: "2026-08-17 06:00:00",
    to_datetime: "2026-08-18 06:00:00",
    status: "Pending",
    reason: "rain since dawn",
    declared_by: "sup@example.com",
    declared_on: "2026-08-17 07:00:00",
    decided_by: null,
    decided_on: null,
    decision_note: null,
  };

  it("shows the move for a pending or approved request", () => {
    expect(summarisePostponement(base)).toContain("awaiting a decision");
    expect(summarisePostponement({ ...base, status: "Approved" })).toContain(
      "2026-08-17 06:00 → 2026-08-18 06:00",
    );
  });

  it("says the plan kept its date when a request was refused", () => {
    const out = summarisePostponement({ ...base, status: "Rejected" });
    expect(out).toContain("refused");
    expect(out).toContain("2026-08-17 06:00");
  });

  it("names who withdrew a request", () => {
    expect(summarisePostponement({ ...base, status: "Withdrawn" })).toContain(
      "sup@example.com",
    );
  });
});
