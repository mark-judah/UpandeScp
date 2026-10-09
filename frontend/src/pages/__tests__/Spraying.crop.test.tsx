import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rangeHeader = vi.fn();
vi.mock("@/pages/maps/RangeHeader", async (orig) => ({
  ...(await orig<object>()),
  RangeHeader: (p: unknown) => { rangeHeader(p); return null; },
}));
vi.mock("@/lib/scouting-api", () => ({
  fetchBedsAndZones: vi.fn().mockResolvedValue([]),
  fetchSprayerGpsLogs: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/hooks/use-map-settings", () => ({
  flyToFarm: vi.fn(),
  useMapSettings: () => ({ settings: null }),
}));
vi.mock("@/components/MapBase", () => ({ MapBase: () => null }));
vi.mock("@/components/LoadingOverlay", () => ({ LoadingOverlay: () => null }));

import { Spraying } from "@/pages/Spraying";

beforeEach(() => rangeHeader.mockReset());

const lastCrop = () =>
  (rangeHeader.mock.calls.at(-1)?.[0] as { value: { crop: string } }).value.crop;

describe("Spraying follows the route crop", () => {
  it("uses the route crop", () => {
    render(<Spraying initialCrop="Avocado" />);
    expect(lastCrop()).toBe("Avocado");
  });
  it("falls back to Rose", () => {
    render(<Spraying />);
    expect(lastCrop()).toBe("Rose");
  });
});
