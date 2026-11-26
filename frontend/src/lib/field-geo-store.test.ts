import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
const getPayload = vi.fn();
const setPayload = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@/lib/frappe", () => ({ call: (...a: unknown[]) => call(...a) }));
vi.mock("@/lib/idb", () => ({
  getPayload: (...a: unknown[]) => getPayload(...a),
  setPayload: (...a: unknown[]) => setPayload(...a),
}));

import { StaleFieldIndex, fetchFieldIndex, loadLatticeBlocks, resetFieldIndexCache, type LatticeBlock } from "@/lib/field-geo";

const blk = (c: number): LatticeBlock => ({ side: 5, aff: [1, 0, 0, 0, 1, 0], h: [0, c, 1 | (1 << 6)], e: [], x: [] });

describe("loadLatticeBlocks", () => {
  beforeEach(() => {
    call.mockReset();
    getPayload.mockReset();
    setPayload.mockClear();
    resetFieldIndexCache();
  });
  it("asks the server only for blocks the local copy lacks, and keeps what it sends", async () => {
    getPayload.mockImplementation(async (key: string) => (key.endsWith(":A") ? { version: "v1", enc: blk(1) } : null));
    call.mockResolvedValue({ version: "v1", blocks: { B: blk(2) } });
    const got = await loadLatticeBlocks("F", "v1", ["A", "B"]);
    expect([...got.keys()].sort()).toEqual(["A", "B"]);
    expect(JSON.parse(call.mock.calls[0][1].blocks)).toEqual(["B"]);
    expect(call.mock.calls[0][0]).toContain("field_lattice.get_field_lattice");
    expect(setPayload).toHaveBeenCalledTimes(1);
  });
  it("a local copy at another version is not used", async () => {
    getPayload.mockResolvedValue({ version: "old", enc: blk(1) });
    call.mockResolvedValue({ blocks: { A: blk(1) } });
    await loadLatticeBlocks("F", "v1", ["A"]);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("throws StaleFieldIndex when the server says the data changed", async () => {
    getPayload.mockResolvedValue(null);
    call.mockResolvedValue({ stale: true, version: "v2" });
    await expect(loadLatticeBlocks("F", "v1", ["A"])).rejects.toBeInstanceOf(StaleFieldIndex);
  });
});

describe("fetchFieldIndex", () => {
  beforeEach(() => {
    call.mockReset();
    resetFieldIndexCache();
  });
  it("asks once per farm", async () => {
    call.mockResolvedValue({ version: "v", counts: { A: [6, 1] }, triads: 6, hexas: 1 });
    await fetchFieldIndex("F");
    const r = await fetchFieldIndex("F");
    expect(call).toHaveBeenCalledTimes(1);
    expect(r.triads).toBe(6);
  });
});
