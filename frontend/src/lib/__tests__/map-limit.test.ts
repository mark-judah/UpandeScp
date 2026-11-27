/** Week fetches run a few at a time, so a big range does not queue every other request on the
 *  server behind it. */
import { describe, expect, it } from "vitest";
import { WEEK_FETCH_CONCURRENCY, mapLimit } from "@/lib/scouting-sync";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("mapLimit", () => {
  it("runs every item, never more than the limit at once, starting in order", async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    await mapLimit(Array.from({ length: 13 }, (_, i) => i), 4, async (i) => {
      started.push(i);
      peak = Math.max(peak, ++running);
      await tick();
      running--;
    });
    expect(started).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(peak).toBe(4);
  });
  it("an empty list is done at once", async () => {
    await expect(mapLimit([], 4, async () => undefined)).resolves.toBeUndefined();
  });
  it("rejects with the first failure and starts nothing after it", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 1, async (i) => {
        started.push(i);
        if (i === 2) throw new Error("week 2");
      }),
    ).rejects.toThrow("week 2");
    expect(started).toEqual([0, 1, 2]);
  });
  it("keeps a handful in flight", () => {
    expect(WEEK_FETCH_CONCURRENCY).toBeGreaterThanOrEqual(2);
    expect(WEEK_FETCH_CONCURRENCY).toBeLessThanOrEqual(6);
  });
});
