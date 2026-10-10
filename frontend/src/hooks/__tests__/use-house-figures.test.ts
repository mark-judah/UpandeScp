import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HouseFigure } from "@/lib/pest-bands";

const fetchMock = vi.fn();
vi.mock("@/lib/threshold-figures-api", () => ({ fetchHouseFigures: (...a: unknown[]) => fetchMock(...a) }));

import { useHouseFigures } from "../use-house-figures";

const fig = (band: HouseFigure["band"]): HouseFigure => ({
  measure: "Count", unit: "per tree", value: 1, margin: null, reliability: "Fair",
  sections_scouted: 9, sections_total: 9, band, action: null, week: "2031-W20",
});

describe("useHouseFigures", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("shows nothing of the previous block while the new block's figures are pending", async () => {
    let resolveB: (v: Record<string, HouseFigure>) => void = () => {};
    fetchMock.mockImplementation((_c: string, block: string) =>
      block === "A" ? Promise.resolve({ Thrips: fig("high") }) : new Promise((r) => { resolveB = r; }),
    );
    const { result, rerender } = renderHook(({ b }) => useHouseFigures("Avocado", b, "f", "t"), {
      initialProps: { b: "A" as string | null },
    });
    await waitFor(() => expect(result.current.Thrips?.band).toBe("high"));

    rerender({ b: "B" });
    expect(result.current).toEqual({});

    await act(async () => resolveB({ Thrips: fig("low") }));
    await waitFor(() => expect(result.current.Thrips?.band).toBe("low"));
  });
});
