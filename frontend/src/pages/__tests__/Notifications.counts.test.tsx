import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({
  counts: {
    loan: { total: 300, unread: 250 },
    transfer: { total: 21, unread: 21 },
    procurement: { total: 3, unread: 0 },
    stock: { total: 0, unread: 0 },
    scouting: { total: 0, unread: 0 },
    plan: { total: 0, unread: 0 },
    reentry: { total: 0, unread: 0 },
  },
  total: 324,
  unread: 271,
}));

vi.mock("@/lib/notifications-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications-api")>("@/lib/notifications-api");
  return {
    ...actual,
    fetchNotifications: vi.fn().mockResolvedValue({ notifications: [], unread: 271 }),
    fetchCategoryCounts: vi.fn().mockResolvedValue(counts),
    markRead: vi.fn(),
  };
});

import { Notifications } from "@/pages/Notifications";

describe("Notifications tab bubbles", () => {
  it("shows skeletons, then a capped bubble per tab with the busiest emphasised", async () => {
    render(<Notifications />);
    expect(screen.getAllByTestId("count-skeleton")).toHaveLength(8);
    await waitFor(() => expect(screen.getAllByTestId("count-bubble")).toHaveLength(8));
    const tab = (name: RegExp) => screen.getByRole("button", { name });
    expect(within(tab(/^All/)).getByTestId("count-bubble")).toHaveTextContent("99+");
    expect(within(tab(/^Loans/)).getByTestId("count-bubble")).toHaveTextContent("99+");
    expect(within(tab(/^Transfers/)).getByTestId("count-bubble")).toHaveTextContent("21");
    expect(within(tab(/^Procurement/)).getByTestId("count-bubble")).toHaveTextContent("0");
    const emph = screen.getAllByTestId("count-bubble").filter((b) => b.hasAttribute("data-emphasised"));
    expect(emph).toHaveLength(1);
    expect(within(tab(/^Loans/)).getByTestId("count-bubble")).toHaveAttribute("data-emphasised");
  });
});
