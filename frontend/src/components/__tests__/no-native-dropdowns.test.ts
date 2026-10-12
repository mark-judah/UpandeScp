/**
 * Every dropdown and date field is the app's own (FilterSelect / HEADER_PILL
 * Select, DatePicker): a native <select> or <input type="date"> draws the
 * browser's control and menu, which is what made Schedule look like a
 * different app.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__tests__" || n === "node_modules" ? [] : files(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

describe("no native dropdowns or date boxes", () => {
  it("has no <select> or type=date in the app's components", () => {
    const offenders = files(SRC).filter((f) => {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      return /<select[\s>]/.test(code) || /type=["']date["']/.test(code);
    });
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
