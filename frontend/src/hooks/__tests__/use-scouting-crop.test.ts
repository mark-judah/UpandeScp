import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMissingWeeks = vi.fn();
const refreshRecentWeeks = vi.fn();
vi.mock("@/lib/scouting-sync", () => ({
  getMissingWeeks: (...a: unknown[]) => getMissingWeeks(...a),
  hydrateRange: vi.fn(),
  invalidateMonth: vi.fn(),
  primeAndDelta: vi.fn().mockResolvedValue(undefined),
  readEntries: vi.fn().mockResolvedValue([]),
  refreshRecentWeeks: (...a: unknown[]) => refreshRecentWeeks(...a),
}));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

import { useScouting } from "@/hooks/use-scouting";

beforeEach(() => {
  getMissingWeeks.mockReset().mockResolvedValue([]);
  refreshRecentWeeks.mockReset().mockResolvedValue(false);
});

describe("useScouting crop scoping", () => {
  it("fetches the Rose slice from the server instead of the all-crop one", async () => {
    renderHook(() => useScouting({ from: "2026-09-01", to: "2026-09-07", crop: "Rose" }));
    await waitFor(() => expect(getMissingWeeks).toHaveBeenCalled());
    expect(getMissingWeeks).toHaveBeenCalledWith("2026-09-01", "2026-09-07", "Rose", undefined);
  });

  it("keeps the all-crop path when no crop is given", async () => {
    renderHook(() => useScouting({ from: "2026-09-01", to: "2026-09-07" }));
    await waitFor(() => expect(getMissingWeeks).toHaveBeenCalled());
    expect(getMissingWeeks).toHaveBeenCalledWith("2026-09-01", "2026-09-07", undefined, undefined);
  });
});
