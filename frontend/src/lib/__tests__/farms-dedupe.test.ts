/** get_farms_and_warehouses on map boot: concurrent callers share one request, and the
 *  unscoped list comes from the page's inline prefetch instead of the network. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("@/lib/frappe", () => ({ call: (...a: unknown[]) => call(...a), isStaleSession: () => false }));

describe("fetchFarmsAndWarehousesResult", () => {
  beforeEach(() => {
    vi.resetModules();
    call.mockReset();
    delete (window as unknown as { SCP?: unknown }).SCP;
  });

  it("concurrent callers for the same crop share one request; it is not kept afterwards", async () => {
    const { fetchFarmsAndWarehousesResult } = await import("@/lib/scouting-api");
    call.mockResolvedValue({ Mutara: ["B1 - MUT"] });
    const [a, b] = await Promise.all([fetchFarmsAndWarehousesResult("Avocado"), fetchFarmsAndWarehousesResult("Avocado")]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(a.farms).toEqual(b.farms);
    await fetchFarmsAndWarehousesResult("Avocado");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("different crops are different requests", async () => {
    const { fetchFarmsAndWarehousesResult } = await import("@/lib/scouting-api");
    call.mockResolvedValue({});
    await Promise.all([fetchFarmsAndWarehousesResult("Avocado"), fetchFarmsAndWarehousesResult()]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("the unscoped list is read from the inline prefetch when the page shipped one", async () => {
    (window as unknown as { SCP: unknown }).SCP = { prefetch: { farms_and_warehouses: { Mutara: ["B1 - MUT"] } } };
    const { fetchFarmsAndWarehousesResult, fetchGreenhouseToFarm } = await import("@/lib/scouting-api");
    expect((await fetchFarmsAndWarehousesResult()).farms).toEqual({ Mutara: ["B1 - MUT"] });
    expect(await fetchGreenhouseToFarm()).toEqual({ "B1 - MUT": "Mutara" });
    expect(call).not.toHaveBeenCalled();
  });

  it("a failed request is reported, not cached", async () => {
    const { fetchFarmsAndWarehousesResult } = await import("@/lib/scouting-api");
    call.mockRejectedValueOnce(new Error("boom"));
    expect((await fetchFarmsAndWarehousesResult("Avocado")).error).toBe("failed");
    call.mockResolvedValueOnce({ Mutara: [] });
    expect((await fetchFarmsAndWarehousesResult("Avocado")).farms).toEqual({ Mutara: [] });
  });
});
