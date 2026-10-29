import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory IndexedDB meta store whose reads and writes yield, like the real one: this is
// what exposes a read-modify-write race when many weeks finish at once.
const meta = new Map<string, unknown>();
const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
vi.mock("@/lib/idb", async (orig) => ({
  ...(await orig<typeof import("@/lib/idb")>()),
  getMeta: async (k: string) => (await tick(), meta.get(k) ?? null),
  setMeta: async (k: string, v: unknown) => (await tick(), void meta.set(k, v)),
  putEntries: async () => tick(),
}));
vi.mock("@/lib/frappe", () => ({ call: async () => (await tick(), { entries: [] }) }));

import { getMissingWeeks, hydrateRange } from "@/lib/scouting-sync";

beforeEach(() => meta.clear());

describe("hydrateRange", () => {
  it("records every week it loaded, however many finish together", async () => {
    await hydrateRange("2026-01-01", "2026-10-29", undefined, "Avocado");
    expect(await getMissingWeeks("2026-01-01", "2026-10-29", "Avocado")).toEqual([]);
  });
});
