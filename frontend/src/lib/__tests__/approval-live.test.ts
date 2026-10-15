import { describe, expect, it } from "vitest";
import {
  EMPTY_FEED,
  eventMatches,
  keepSelection,
  mergeFeed,
  newPlansMessage,
  type LiveScope,
  type SprayPlanEvent,
} from "@/lib/approval-live";
import type { PendingWorkOrder } from "@/lib/spray-plan-api";

const wo = (name: string): PendingWorkOrder =>
  ({ name, required_items: [], is_forwarded: false }) as PendingWorkOrder;

const scope: LiveScope = { from: "2026-10-15", to: "2026-10-15", dateBasis: "scheduled", farm: "", greenhouse: "" };
const ev = (over: Partial<SprayPlanEvent> = {}): SprayPlanEvent => ({
  change: "created", name: "WO-1", workflow_state: "Awaiting Approval",
  date: "2026-10-15", created: "2026-10-14", farm: "Karen", greenhouse: "GH 1", ...over,
});

describe("mergeFeed", () => {
  it("does not announce the first load or a filter change", () => {
    const { state, added } = mergeFeed(EMPTY_FEED, [wo("A"), wo("B")], false);
    expect(added).toEqual([]);
    expect(state.fresh.size).toBe(0);
    expect(state.wos.map((w) => w.name)).toEqual(["A", "B"]);
  });

  it("announces plans that arrive on a live refresh and marks them fresh", () => {
    const first = mergeFeed(EMPTY_FEED, [wo("A")], false).state;
    const { state, added } = mergeFeed(first, [wo("C"), wo("A")], true);
    expect(added.map((w) => w.name)).toEqual(["C"]);
    expect([...state.fresh]).toEqual(["C"]);
    expect(state.wos.map((w) => w.name)).toEqual(["C", "A"]); // server order wins
  });

  it("dedupes a plan listed twice and never announces a known plan again", () => {
    const first = mergeFeed(EMPTY_FEED, [wo("A")], false).state;
    const one = mergeFeed(first, [wo("A"), wo("N"), wo("N")], true);
    expect(one.state.wos.map((w) => w.name)).toEqual(["A", "N"]);
    expect(one.added).toHaveLength(1);
    const two = mergeFeed(one.state, [wo("A"), wo("N")], true);
    expect(two.added).toEqual([]);
    expect([...two.state.fresh]).toEqual(["N"]); // still unseen
  });

  it("forgets fresh plans that left the list", () => {
    const a = mergeFeed(mergeFeed(EMPTY_FEED, [wo("A")], false).state, [wo("A"), wo("N")], true).state;
    const b = mergeFeed(a, [wo("A")], true).state;
    expect(b.fresh.size).toBe(0);
  });
});

describe("keepSelection", () => {
  it("keeps the selection through a refresh and drops only plans that left", () => {
    const sel = new Set(["A", "B"]);
    expect(keepSelection(sel, [wo("A"), wo("B"), wo("NEW")])).toBe(sel);
    expect([...keepSelection(sel, [wo("B"), wo("NEW")])]).toEqual(["B"]);
  });
});

describe("eventMatches", () => {
  it("filters by the selected date on the chosen basis", () => {
    expect(eventMatches(ev(), scope)).toBe(true);
    expect(eventMatches(ev({ date: "2026-10-16" }), scope)).toBe(false);
    expect(eventMatches(ev({ date: "2026-10-16", created: "2026-10-15" }), { ...scope, dateBasis: "created" })).toBe(true);
  });
  it("filters by farm and greenhouse, and ignores junk", () => {
    expect(eventMatches(ev(), { ...scope, farm: "Karen" })).toBe(true);
    expect(eventMatches(ev(), { ...scope, farm: "Other" })).toBe(false);
    expect(eventMatches(ev(), { ...scope, greenhouse: "GH 2" })).toBe(false);
    expect(eventMatches(null, scope)).toBe(false);
    expect(eventMatches({}, scope)).toBe(false);
  });
  it("treats an open range as matching any date", () => {
    expect(eventMatches(ev({ date: "2030-01-01" }), { ...scope, from: "", to: "" })).toBe(true);
  });
});

describe("newPlansMessage", () => {
  it("names the day when the plans share one", () => {
    expect(newPlansMessage(2, ["2026-10-15", "2026-10-15"])).toBe("2 new plans for 15 Oct");
    expect(newPlansMessage(1, ["2026-10-15"])).toBe("1 new plan for 15 Oct");
  });
  it("falls back when the dates differ", () => {
    expect(newPlansMessage(2, ["2026-10-15", "2026-10-16"])).toBe("2 new plans for the selected dates");
  });
});
