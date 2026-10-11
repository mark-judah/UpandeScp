import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SprayersPayload } from "@/lib/teams-api";

const SPRAYERS: SprayersPayload = {
  sprayers: [
    {
      name: "SPR-00001", employee: "KR-001", employee_name: "Alice Chebet", farm: "Chepsito",
      spray_team: "CHEPSITO CSU 1", role: "Sprayer", status: "Active",
      hours_30d: 2, weighted_30d: 8, hours_total: 10, weighted_total: 30, last_exposure: "2026-10-01",
    },
  ],
  flags: { rows: 1, no_duration: 0, hazard_unknown: 0, products_unclassified: 0 },
};

let resolve: (p: SprayersPayload) => void = () => undefined;
vi.mock("@/lib/teams-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teams-api")>()),
  fetchSprayers: () => new Promise<SprayersPayload>((r) => (resolve = r)),
  fetchSprayerDetail: () => new Promise(() => undefined),
}));

const { Sprayers } = await import("@/pages/Sprayers");

describe("Sprayers — in-place skeletons", () => {
  it("draws the real frame while the register loads, then fills it", async () => {
    const { container } = render(<Sprayers initialCrop="Rose" />);

    // Frame: title, tabs, figure labels, card titles, table headings, fact labels.
    expect(screen.getByRole("heading", { name: "Sprayers" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Records" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All sprayers" })).toBeInTheDocument();
    expect(screen.getByText("Weighted 30d")).toBeInTheDocument();
    expect(screen.getByText("Exposure per product")).toBeInTheDocument();
    const products = screen.getByRole("table", { name: "Exposure per product" });
    expect(within(products).getByRole("columnheader", { name: "Toxicity" })).toBeInTheDocument();
    expect(screen.getByText("Last exposure")).toBeInTheDocument();
    expect(screen.getByLabelText("Find a sprayer")).toBeDisabled();

    // Only the data slots are skeletons; no empty-state wording, no spinner text.
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('[data-skeleton="person-list"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-skeleton="row"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(screen.queryByText(/Nobody on the register/)).toBeNull();

    await act(async () => resolve(SPRAYERS));

    expect(screen.getByTestId("person-SPR-00001")).toBeInTheDocument();
    expect(container.querySelector('[data-skeleton="person-list"]')).toBeNull();
    expect(screen.getByTestId("sprayer-record")).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/border-l-|border-left/);
  });
});
