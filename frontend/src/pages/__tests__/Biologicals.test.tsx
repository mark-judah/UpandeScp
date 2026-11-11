import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const releases = {
  rows: [{
    name: "BIO-REL-00001", released_at: "2026-11-05 08:00:00", greenhouse: "Karen GH 01 - KR", farm: "Karen",
    predator: "Phytoseiulus", stage: "Adult", quantity: 3, uom: "Bottle", item: "Phytoseiulus persimilis",
    batch_no: null, store: "Chemical Store Karen - KR", released_by_name: "Jane", stock_entry: "MAT-STE-1", notes: null,
  }],
  by_predator: [{ predator: "Phytoseiulus", uom: "Bottle", quantity: 3 }],
  by_greenhouse: [{ greenhouse: "Karen GH 01 - KR", quantity: 3 }],
  filters: { greenhouses: ["Karen GH 01 - KR"], predators: ["Phytoseiulus"] },
};
const mortality = {
  label: "Expected mortality: released quantity x ingredient mortality (IOBC class estimate). Not a count of dead animals.",
  from_date: "2026-08-13", to_date: "2026-11-11", presence_days: 14,
  rows: [{ wo: "W1", when: "2026-11-06 09:00:00", greenhouse: "Karen GH 01 - KR", predator: "Phytoseiulus",
    present: 3, mortality_pct: 90, expected_kill: 2.7, uom: "Bottle", products: ["Vertimec"] }],
  by_predator: { Phytoseiulus: 2.7 }, by_greenhouse: { "Karen GH 01 - KR": 2.7 }, total: 2.7,
};

const fetchReleases = vi.fn(async (_f?: unknown) => releases);
const fetchMortality = vi.fn(async (_f?: unknown) => mortality);
vi.mock("@/lib/biologicals-api", async (orig) => ({
  ...(await orig<typeof import("@/lib/biologicals-api")>()),
  fetchReleases: (f: unknown) => fetchReleases(f),
  fetchMortality: (f: unknown) => fetchMortality(f),
}));

const { Biologicals } = await import("@/pages/Biologicals");

describe("Crop Protection ▸ Biologicals", () => {
  it("lists releases and labels the mortality tab as expected", async () => {
    const { findByText, getByRole, getByTestId, getAllByText } = render(<Biologicals initialCrop="Rose" />);
    expect(getByRole("heading", { name: "Biologicals" })).toBeInTheDocument();
    expect(await findByText("Jane")).toBeInTheDocument();
    expect(getAllByText("Phytoseiulus").length).toBeGreaterThan(0);
    expect(fetchReleases.mock.calls[0][0]).toMatchObject({ greenhouse: undefined });

    fireEvent.mouseDown(getByRole("tab", { name: "Expected mortality" }));
    fireEvent.click(getByRole("tab", { name: "Expected mortality" }));
    await waitFor(() => expect(getByTestId("mortality-label").textContent).toMatch(/Expected mortality/));
    expect(getByTestId("mortality-label").textContent).toMatch(/Not a count of dead animals/);
    expect(await findByText("Vertimec")).toBeInTheDocument();
  });
});
