/** putEntries writes a big batch in slices with the page let through between them, instead of
 *  one transaction that structured-clones thousands of entries in a single long task. */
import { describe, expect, it } from "vitest";
import { PUT_SLICE, writeInSlices } from "@/lib/idb";

describe("writeInSlices", () => {
  it("writes every item once, in order, in slices, pausing between (not before) slices", async () => {
    const log: string[] = [];
    const items = Array.from({ length: 450 }, (_, i) => i);
    await writeInSlices(
      items,
      200,
      async (s) => void log.push(`w${s[0]}-${s[s.length - 1]}`),
      async () => void log.push("pause"),
    );
    expect(log).toEqual(["w0-199", "pause", "w200-399", "pause", "w400-449"]);
  });
  it("nothing to write is no write and no pause", async () => {
    const log: string[] = [];
    await writeInSlices([], 200, async () => void log.push("w"), async () => void log.push("p"));
    expect(log).toEqual([]);
  });
  it("a write failure stops the rest", async () => {
    let n = 0;
    await expect(
      writeInSlices([1, 2, 3], 1, async () => {
        if (++n === 2) throw new Error("quota");
      }, async () => undefined),
    ).rejects.toThrow("quota");
    expect(n).toBe(2);
  });
  it("the slice is small enough to stay a short task", () => {
    expect(PUT_SLICE).toBeLessThanOrEqual(250);
  });
});
