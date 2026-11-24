import { describe, expect, it } from "vitest";
import { createLatest } from "../latest-only";

describe("createLatest", () => {
  it("keeps the latest request when responses resolve out of order", async () => {
    const g = createLatest();
    const applied: string[] = [];
    const run = (name: string, ms: number) => {
      const ok = g.start();
      return new Promise<void>((r) => setTimeout(r, ms)).then(() => { if (ok()) applied.push(name); });
    };
    await Promise.all([run("A", 30), run("B", 5)]);
    expect(applied).toEqual(["B"]);
  });
  it("a lone request stays current", () => {
    const g = createLatest();
    expect(g.start()()).toBe(true);
  });
});
