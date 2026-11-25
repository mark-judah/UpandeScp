import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
const getPayload = vi.fn();
const setPayload = vi.fn((..._a: unknown[]) => Promise.resolve());
vi.mock("@/lib/frappe", () => ({ call: (...a: unknown[]) => call(...a) }));
vi.mock("@/lib/idb", () => ({
  getPayload: (...a: unknown[]) => getPayload(...a),
  setPayload: (...a: unknown[]) => setPayload(...a),
}));

import { fetchFieldLayers, resetFieldLayersCache } from "@/lib/field-geo";

describe("field layers local copy", () => {
  beforeEach(() => {
    call.mockReset();
    getPayload.mockReset();
    setPayload.mockClear();
    resetFieldLayersCache();
  });

  it("does not cache a response without `tri`", async () => {
    getPayload.mockResolvedValue(null);
    call.mockResolvedValue({ version: "v1", blocks: { type: "FeatureCollection", features: [] } });
    const r = await fetchFieldLayers("F");
    expect(r.tri.blocks).toEqual({});
    expect(setPayload).not.toHaveBeenCalled();
  });

  it("caches a response with `tri`", async () => {
    getPayload.mockResolvedValue(null);
    call.mockResolvedValue({ version: "v1", blocks: { type: "FeatureCollection", features: [] }, tri: { q: 1e7, blocks: {} } });
    await fetchFieldLayers("F");
    expect(setPayload).toHaveBeenCalledTimes(1);
  });

  it("ignores a held copy that has no `tri` even when the server says unchanged", async () => {
    getPayload.mockResolvedValue({ version: "old", blocks: { type: "FeatureCollection", features: [] } });
    call.mockResolvedValue({ version: "old", blocks: { type: "FeatureCollection", features: [] }, tri: { q: 1e7, blocks: {} } });
    await fetchFieldLayers("F");
    expect(call.mock.calls[0][1].have).toBeUndefined();
  });
});
