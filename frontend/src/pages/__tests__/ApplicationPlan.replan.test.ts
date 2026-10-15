import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseReplanParams, pendingNote, resolveReplan } from "../replanPrefill";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const HASH =
  "#/roses/application-plan?replan=MFG-WO-0001&greenhouse=Karen%20GH1&date=2026-10-20" +
  "&target=Thrips&target=Mites&item=CHEM-1&item=CHEM-2&item=CHEM-9";

describe("Re-plan prefill params", () => {
  it("parses repeated target and item keys", () => {
    expect(parseReplanParams(HASH)).toEqual({
      replan: "MFG-WO-0001",
      greenhouse: "Karen GH1",
      date: "2026-10-20",
      targets: ["Thrips", "Mites"],
      items: ["CHEM-1", "CHEM-2", "CHEM-9"],
    });
  });

  it("ignores links without a replan key", () => {
    expect(parseReplanParams("#/roses/application-plan")).toBeNull();
    expect(parseReplanParams("#/roses/application-plan?greenhouse=x")).toBeNull();
  });

  it("preselects greenhouse, date and targets; unknowns are listed as skipped", () => {
    const p = parseReplanParams(HASH)!;
    const r = resolveReplan(p, { greenhouses: ["Karen GH1"], targets: ["Thrips"] });
    expect(r).toEqual({
      greenhouse: "Karen GH1",
      date: "2026-10-20",
      targets: ["Thrips"],
      skipped: ["target Mites"],
    });
    const bad = resolveReplan(p, { greenhouses: [], targets: [] });
    expect(bad.greenhouse).toBe("");
    expect(bad.skipped).toContain("greenhouse Karen GH1");
  });

  it("words the pending note", () => {
    expect(pendingNote(3)).toBe("3 chemicals from the stale plan will be added when you pick a tank mix");
    expect(pendingNote(1)).toContain("1 chemical from");
  });
});

describe("ApplicationPlan re-plan wiring", () => {
  const page = src("../ApplicationPlan.tsx");

  it("parses the hash, cleans the URL and never submits", () => {
    expect(page).toContain("parseReplanParams(window.location.hash)");
    expect(page).toContain("window.history.replaceState(null");
    expect(page).toContain("Re-planning {replanWo} — check the details before submitting");
  });

  it("queues items until a tank mix is loaded, then adds them via makeChemRow", () => {
    expect(page).toContain("!replanPending.length || !bom || bomLoading || bomDetails?.name !== bom");
    expect(page).toContain("mappedStores?.chemical_store");
    expect(page).toContain("Skipped from the stale plan");
  });

  it("applies targets after the greenhouse reset effect", () => {
    expect(page).toContain("replanTargetsRef.current = { greenhouse: res.greenhouse || greenhouse");
  });
});
