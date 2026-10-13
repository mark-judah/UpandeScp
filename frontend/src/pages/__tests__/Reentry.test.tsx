import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryBoard } from "@/lib/reentry-api";

vi.mock("@/hooks/use-crop-farms", () => ({
  useCropFarms: () => ({
    farms: { Chepsito: ["Chepsito GH 1 - KR", "Chepsito GH 2 - KR"], Kapkolia: ["Kapkolia GH 9 - KR"] },
    loading: false,
  }),
}));

const BOARD: EntryBoard = {
  now: "2026-10-13 12:00:00",
  houses: [
    {
      house: "Chepsito GH 1 - KR", house_label: "Chepsito GH 1", farm: "Chepsito", status: "no_entry",
      reentry_time: "2026-10-13 15:12:00", harvest_after: "2026-10-16 09:00:00",
      work_order: "WO-1", ended_at: "2026-10-13 09:00:00", cleared_at: null, products: ["Mancozeb"],
    },
    {
      house: "Chepsito GH 2 - KR", house_label: "Chepsito GH 2", farm: "Chepsito", status: "harvest_held",
      reentry_time: "2026-10-13 08:00:00", harvest_after: "2026-10-15 09:00:00",
      work_order: "WO-2", ended_at: "2026-10-12 20:00:00", cleared_at: null, products: ["Abamectin"],
    },
    {
      house: "Kapkolia GH 9 - KR", house_label: "Kapkolia GH 9", farm: "Kapkolia", status: "clear",
      reentry_time: "2026-10-13 06:00:00", harvest_after: null,
      work_order: "WO-3", ended_at: "2026-10-13 00:00:00", cleared_at: "2026-10-13 06:00:00", products: ["Sulphur"],
    },
    {
      house: "Kapkolia GH 8 - KR", house_label: "Kapkolia GH 8", farm: "Kapkolia", status: "clear",
      reentry_time: "2026-10-09 06:00:00", harvest_after: null,
      work_order: "WO-4", ended_at: "2026-10-09 00:00:00", cleared_at: "2026-10-09 06:00:00", products: ["Old"],
    },
  ],
};

const fetchMock = vi.fn(async (..._a: unknown[]) => BOARD);
vi.mock("@/lib/reentry-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reentry-api")>()),
  fetchEntryBoard: (...a: unknown[]) => fetchMock(...a),
}));

const { Reentry } = await import("@/pages/Reentry");
const { formatRemaining } = await import("@/lib/reentry-api");

describe("Re-entry board", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    window.localStorage.clear();
  });

  it("draws the frame with skeleton rows before the data arrives", () => {
    render(<Reentry initialCrop="Rose" />);
    expect(screen.getByRole("heading", { name: "Re-entry" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "No entry" })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-skeleton="row"]').length).toBeGreaterThan(0);
  });

  it("splits houses into no entry, harvest held and cleared in the last 24 h", async () => {
    render(<Reentry initialCrop="Rose" />);
    const noEntry = await screen.findByTestId("section-no-entry");
    await waitFor(() => expect(within(noEntry).getAllByTestId("no-entry-row")).toHaveLength(1));
    expect(within(noEntry).getByText("Chepsito GH 1")).toBeInTheDocument();
    expect(within(noEntry).getByText("Mancozeb")).toBeInTheDocument();
    // server now 12:00, re-entry 15:12 -> 3 h 12 min, whatever the browser's zone
    expect(within(noEntry).getByText("3 h 12 min")).toBeInTheDocument();

    const held = screen.getByTestId("section-harvest-held");
    expect(within(held).getAllByTestId("held-row")).toHaveLength(1);
    expect(within(held).getByText("Chepsito GH 2")).toBeInTheDocument();

    const cleared = screen.getByTestId("section-cleared");
    expect(within(cleared).getAllByTestId("cleared-row")).toHaveLength(1);
    expect(within(cleared).getByText("Kapkolia GH 9")).toBeInTheDocument();
    expect(within(cleared).queryByText("Kapkolia GH 8")).toBeNull();
  });

  it("asks for the route's crop", async () => {
    render(<Reentry initialCrop="Avocado" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("Avocado");
  });

  it("formats a countdown", () => {
    expect(formatRemaining(45 * 60000)).toBe("45 min");
    expect(formatRemaining(2 * 3600000)).toBe("2 h");
    expect(formatRemaining(26 * 3600000)).toBe("1 d 2 h");
    expect(formatRemaining(-5)).toBe("0 min");
  });
});
