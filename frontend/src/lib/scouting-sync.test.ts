import { beforeEach, describe, expect, it, vi } from "vitest";

const getEntriesInRange = vi.fn();
vi.mock("@/lib/idb", async (orig) => ({
  ...(await orig<typeof import("@/lib/idb")>()),
  getEntriesInRange: (...a: unknown[]) => getEntriesInRange(...a),
}));

import { readEntries } from "@/lib/scouting-sync";

const row = (name: string, crop?: string, extra: Record<string, unknown> = {}) => ({
  name,
  date_of_capture: "2026-09-01",
  crop_scouted: crop,
  ...extra,
});

beforeEach(() => getEntriesInRange.mockReset());

describe("readEntries crop filter", () => {
  it("keeps an Avocado row on the Avocado map and off the Rose map", async () => {
    getEntriesInRange.mockResolvedValue([
      row("avo", "Avocado", { block: "Block 1" }),
      row("rose", "Rose", { greenhouse: "GH 1" }),
    ]);
    const avo = await readEntries("2026-09-01", "2026-09-07", { crop: "Avocado" });
    expect(avo.map((r) => r.name)).toEqual(["avo"]);
    const rose = await readEntries("2026-09-01", "2026-09-07", { crop: "Rose" });
    expect(rose.map((r) => r.name)).toEqual(["rose"]);
  });

  it("still treats a legacy row with no crop as Rose", async () => {
    getEntriesInRange.mockResolvedValue([row("old")]);
    expect(await readEntries("2026-09-01", "2026-09-07", { crop: "Rose" })).toHaveLength(1);
    expect(await readEntries("2026-09-01", "2026-09-07", { crop: "Avocado" })).toHaveLength(0);
  });
});
