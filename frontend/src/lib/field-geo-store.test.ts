import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
const getPayload = vi.fn();
const setPayload = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@/lib/frappe", () => ({ call: (...a: unknown[]) => call(...a) }));
vi.mock("@/lib/idb", () => ({
  getPayload: (...a: unknown[]) => getPayload(...a),
  setPayload: (...a: unknown[]) => setPayload(...a),
}));

import {
  StaleFieldIndex,
  fetchFieldIndex,
  loadLatticeBlocks,
  prefetchFarmLattice,
  prefetchGroups,
  resetFieldIndexCache,
  type LatticeBlock,
} from "@/lib/field-geo";

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

describe("the lattice prefetch", () => {
  beforeEach(() => {
    call.mockReset();
    getPayload.mockReset();
    setPayload.mockClear();
    resetFieldIndexCache();
  });
  it("a later load reuses the prefetch's request instead of asking again", async () => {
    getPayload.mockResolvedValue(null);
    let release: (v: unknown) => void = () => undefined;
    call.mockImplementation(() => new Promise((r) => (release = r)));
    prefetchFarmLattice("F", { version: "v1", counts: { A: [6, 1], B: [6, 1], Empty: [0, 0] }, triads: 12, hexas: 2 });
    const later = loadLatticeBlocks("F", "v1", ["B", "A"]);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(JSON.parse(call.mock.calls[0][1].blocks)).toEqual(["A", "B"]); // blocks without triangles are not asked for
    release({ blocks: { A: blk(1), B: blk(2) } });
    const got = await later;
    expect(got.get("B")!.h[1]).toBe(2);
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("a failed request is forgotten, so the next load asks again", async () => {
    getPayload.mockResolvedValue(null);
    call.mockRejectedValueOnce(new Error("502"));
    await expect(loadLatticeBlocks("F", "v1", ["A"])).rejects.toThrow("502");
    call.mockResolvedValueOnce({ blocks: { A: blk(3) } });
    expect((await loadLatticeBlocks("F", "v1", ["A"])).get("A")!.h[1]).toBe(3);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("another version is another request", async () => {
    getPayload.mockResolvedValue(null);
    call.mockResolvedValue({ blocks: { A: blk(1) } });
    await loadLatticeBlocks("F", "v1", ["A"]);
    await loadLatticeBlocks("F", "v2", ["A"]);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("splits a farm into two requests, at most 60 blocks each, at least 8", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `B${i}`);
    expect(prefetchGroups([])).toEqual([]);
    expect(prefetchGroups(names(5)).map((g) => g.length)).toEqual([5]);
    expect(prefetchGroups(names(62)).map((g) => g.length)).toEqual([31, 31]);
    expect(prefetchGroups(names(200)).map((g) => g.length)).toEqual([60, 60, 60, 20]);
  });
});
