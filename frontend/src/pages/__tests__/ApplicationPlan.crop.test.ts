import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("ApplicationPlan crop wiring", () => {
  const page = src("../ApplicationPlan.tsx");
  const app = src("../../App.tsx");

  it("no longer hard-codes Rose for diagnose", () => {
    expect(page).not.toMatch(/crop:\s*"Rose"/);
  });

  it("bootstraps with the route crop on load and after creating a BOM", () => {
    expect(page.match(/fetchCreatorBootstrap\(initialCrop\)/g)?.length).toBe(2);
    expect(page).not.toMatch(/fetchCreatorBootstrap\(\)/);
  });

  it("receives the route crop from the router", () => {
    expect(app).toContain("<ApplicationPlan initialCrop={cropName} />");
    expect(app).toContain("<AvocadoHeatMap initialCrop={cropName} />");
    expect(app).toContain("<Spraying initialCrop={cropName} />");
  });
});
