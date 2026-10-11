import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchLatestTrapReading = vi.fn();
vi.mock("@/lib/trap-reading-api", () => ({
  fetchLatestTrapReading: (...a: unknown[]) => fetchLatestTrapReading(...a),
}));

const { TrapReadingCard } = await import("@/components/traps/TrapReadingCard");

beforeEach(() => {
  fetchLatestTrapReading.mockReset();
});

describe("TrapReadingCard", () => {
  it("shows the recorder's Employee photo, name, the reading time, count and pest", async () => {
    fetchLatestTrapReading.mockResolvedValue({
      trap: "KR - T1", entry: "SE-1", scout: "100961", scoutName: "IMELDA WANZA MUTUA",
      image: "/private/files/100961.jpg", date: "2026-10-09", time: "14:35:10", count: 7, pest: "Thrips",
      house: "GH1 - KR",
    });
    const { container } = render(
      <TrapReadingCard trap="KR - T1" from="2026-10-05" to="2026-10-11" onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId("trap-card-scout")).toHaveTextContent("IMELDA WANZA MUTUA"));
    expect(container.querySelector('img[src="/private/files/100961.jpg"]')).not.toBeNull();
    expect(screen.getByTestId("trap-card-time")).toHaveTextContent("9 Oct 2026 · 14:35");
    expect(screen.getByTestId("trap-card-count")).toHaveTextContent("7");
    expect(screen.getByText("Thrips")).toBeInTheDocument();
    expect(fetchLatestTrapReading).toHaveBeenCalledWith("KR - T1", "2026-10-05", "2026-10-11");
  });

  it("shows the map's own latest reading at once, with initials until a photo arrives", () => {
    fetchLatestTrapReading.mockReturnValue(new Promise(() => {}));
    render(
      <TrapReadingCard
        trap="KR - T1"
        local={{ scout: "John Kip", date: "2026-10-08", time: "09:10:00", count: 3, pest: "FCM" }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("trap-card-scout")).toHaveTextContent("John Kip");
    expect(screen.getByTestId("trap-card-time")).toHaveTextContent("8 Oct 2026 · 09:10");
    expect(screen.getByText("JK")).toBeInTheDocument();
  });

  it("says so when the trap has no reading, and closes on Escape", async () => {
    fetchLatestTrapReading.mockResolvedValue({ trap: "KR - T2", entry: null });
    const onClose = vi.fn();
    render(<TrapReadingCard trap="KR - T2" onClose={onClose} />);
    expect(await screen.findByText(/No reading at this trap/)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
