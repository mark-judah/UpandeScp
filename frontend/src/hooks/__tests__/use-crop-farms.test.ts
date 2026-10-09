import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchFarmsAndWarehousesResult = vi.fn();
vi.mock("@/lib/scouting-api", () => ({
  fetchFarmsAndWarehousesResult: (...a: unknown[]) => fetchFarmsAndWarehousesResult(...a),
}));

import { useCropFarms } from "@/hooks/use-crop-farms";

beforeEach(() => {
  fetchFarmsAndWarehousesResult.mockReset().mockImplementation(async (crop?: string) => ({
    farms: crop === "Avocado" ? { Lokitela: ["AIRSTRIP BLK 1 - KL"] } : { Karen: ["Karen GH 01 - KR"] },
  }));
});

describe("useCropFarms", () => {
  it("asks the server for the route crop's farms", async () => {
    const { result } = renderHook(() => useCropFarms("Avocado"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchFarmsAndWarehousesResult).toHaveBeenCalledWith("Avocado");
    expect(Object.keys(result.current.farms)).toEqual(["Lokitela"]);
  });

  it("refetches when the crop changes", async () => {
    const { result, rerender } = renderHook(({ c }) => useCropFarms(c), { initialProps: { c: "Avocado" } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ c: "Rose" });
    await waitFor(() => expect(Object.keys(result.current.farms)).toEqual(["Karen"]));
    expect(fetchFarmsAndWarehousesResult).toHaveBeenLastCalledWith("Rose");
  });
});
