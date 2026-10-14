import { describe, expect, it } from "vitest";
import {
  groupViolations,
  modeBadge,
  pickerFilters,
  pickerState,
  saveGate,
  sortBoms,
  type CheckResult,
  type ProductEligibility,
  type Violation,
} from "./spray-compliance-api";

const v = (rule: string, mode: Violation["mode"], overridden = false): Violation => ({
  rule, mode, overridden, message: `${rule} msg`, products: [], targets: [], codes: [], key: `${rule}:k`,
});
const res = (violations: Violation[], extra: Partial<CheckResult> = {}): CheckResult => ({
  violations, coverage: [], blocking: false, needs_override: false, status: "Clean", can_override: false, ...extra,
});

describe("saveGate", () => {
  it("is ok when clean", () => expect(saveGate(res([])).state).toBe("ok"));
  it("warns but allows", () => expect(saveGate(res([v("target_match", "Warn")])).state).toBe("warn"));
  it("blocks on a hard block", () => {
    const g = saveGate(res([v("same_moa_in_mix", "Block")], { blocking: true, status: "Blocked" }));
    expect(g.state).toBe("blocked");
    expect(g.reason).toContain("same_moa_in_mix msg");
  });
  it("asks for an override when only overridable rules block", () =>
    expect(saveGate(res([v("moa_rotation", "Block (GM override)")], { blocking: true, needs_override: true })).state).toBe("override"));
});

describe("groupViolations", () => {
  it("groups by rule in engine order with labels", () => {
    const g = groupViolations([v("tank_mix_incompatible", "Warn"), v("target_match", "Warn"), v("target_match", "Block")]);
    expect(g.map((x) => x.rule)).toEqual(["target_match", "tank_mix_incompatible"]);
    expect(g[0].items).toHaveLength(2);
    expect(g[0].label).toBe("Product targets");
  });
  it("keeps rules it does not know in an Other group at the end", () => {
    const g = groupViolations([v("brand_new_rule", "Warn"), v("target_match", "Warn"), v("another_rule", "Block")]);
    expect(g.map((x) => x.rule)).toEqual(["target_match", "other"]);
    expect(g[1].label).toBe("Other");
    expect(g[1].items.map((x) => x.rule)).toEqual(["brand_new_rule", "another_rule"]);
  });
});

describe("modeBadge", () => {
  it("names each state", () => {
    expect(modeBadge("Block", false).text).toBe("Blocked");
    expect(modeBadge("Block (GM override)", false).text).toBe("Needs GM override");
    expect(modeBadge("Block (GM override)", true).text).toBe("Overridden");
    expect(modeBadge("Warn", false).text).toBe("Warning");
  });
});

describe("sortBoms", () => {
  it("puts eligible first and keeps unknown last", () => {
    const boms = [{ name: "A" }, { name: "B" }, { name: "C" }];
    const elig = { A: { eligible: false }, B: { eligible: true } } as never;
    expect(sortBoms(boms, elig).map((b) => b.name)).toEqual(["B", "A", "C"]);
  });
});

describe("pickerState", () => {
  const p = (rules: string[], worst: ProductEligibility["worst_mode"] = rules.length ? "Warn" : "Off"): ProductEligibility => ({
    item: "X", name: "X", eligible: rules.length === 0, worst_mode: worst, reasons: rules.map((r) => `${r} msg`),
    rules, codes: [], targets: [], non_target: false,
  });
  it("shows a suitable product as is", () => expect(pickerState(p([]), false)).toBe("ok"));
  it("shows an unranked result as is", () => expect(pickerState(undefined, false)).toBe("ok"));
  it("greys a registered product that breaks a warn rule instead of hiding it", () => {
    expect(pickerState(p(["moa_rotation"]), false)).toBe("greyed");
    expect(pickerState(p(["same_moa_in_mix", "max_sprays"], "Block (GM override)"), false)).toBe("greyed");
  });
  it("hides a product not registered for the targets unless Show all", () => {
    expect(pickerState(p(["target_match"]), false)).toBe("hidden");
    expect(pickerState(p(["target_match"]), true)).toBe("greyed");
  });
  it("disables a hard-blocked product", () => {
    expect(pickerState(p(["tank_mix_incompatible"], "Block"), false)).toBe("blocked");
    expect(pickerState(p(["target_match"], "Block"), false)).toBe("hidden");
    expect(pickerState(p(["target_match"], "Block"), true)).toBe("blocked");
  });
  it("offers Show all only when it would reveal something", () => {
    expect(pickerFilters([p([]), p(["moa_rotation"])])).toBe(false);
    expect(pickerFilters([p([]), p(["target_match"])])).toBe(true);
  });
});
