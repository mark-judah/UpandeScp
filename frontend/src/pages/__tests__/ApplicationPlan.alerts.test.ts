import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A variable path on purpose: Vite rewrites `new URL("<literal>", import.meta.url)`
// into an asset URL, which readFileSync cannot open (ApplicationPlan.crop.test.ts
// uses the same helper).
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ApplicationPlan curative alerts (thresholds D7)", () => {
  const page = src("../ApplicationPlan.tsx");

  it("replaces the client-side recommendation with the server's band", () => {
    expect(page).not.toContain("Heavy infestation");
    expect(page).not.toMatch(/const recommendation\s*=/);
    expect(page).toContain("<CurativeAlerts");
  });

  it("badges greenhouses and links the saved plan to its alert", () => {
    expect(page).toContain("ghActionBadge(bootstrap?.alerts?.[g])");
    expect(page).toContain("alert: curativeAlert || undefined");
  });

  it("prefills greenhouse, Curative and the target", () => {
    expect(page).toContain("prefillRef.current = { greenhouse: a.warehouse, target: a.observation }");
    expect(page).toContain('setClassification("Curative")');
  });

  it("unlinks the alert when its pest is deselected and when the server refuses it", () => {
    expect(page).toContain("alertLinkFor(bootstrap?.alerts?.[greenhouse], cur, selectedTargets)");
    expect(page).toContain('if (/Scouting alert/i.test(errorText(e))) setCurativeAlert("")');
  });
});
