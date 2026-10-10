import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScoutingPin } from "@/lib/spread-api";

const pending: Record<string, (pins: ScoutingPin[]) => void> = {};
vi.mock("@/lib/spread-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/spread-api")>()),
  getHouseClusters: vi.fn(() => new Promise(() => {})),
  listPins: vi.fn(
    (_crop: string, warehouse: string) => new Promise<ScoutingPin[]>((res) => (pending[warehouse] = res)),
  ),
}));

import { useHouseOverlays } from "../use-house-overlays";

const pin = (name: string) => ({ name, title: name, kind: "Area", stations: [] }) as unknown as ScoutingPin;

describe("useHouseOverlays pins", () => {
  it("ignores a slower answer for the house it has left", async () => {
    const { result, rerender } = renderHook(
      ({ wh }) => useHouseOverlays({ crop: "Rose", warehouse: wh, observation: null, kind: "pest" }),
      { initialProps: { wh: "GH A" } },
    );
    rerender({ wh: "GH B" });
    await act(async () => pending["GH B"]([pin("b")]));
    await act(async () => pending["GH A"]([pin("a")]));
    expect(result.current.pins.map((p) => p.name)).toEqual(["b"]);
  });
});
