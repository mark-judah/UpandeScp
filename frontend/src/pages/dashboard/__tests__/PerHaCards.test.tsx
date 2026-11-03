import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/gallery/ObservationGallery", () => ({
  ObservationName: ({ name }: { name: string }) => <span>{name}</span>,
}));

import { PerHaBlocksCard, PerHaSeverityCard } from "../PerHaCards";
import type { PerHaPayload } from "../pests-diseases-types";

const perHa: PerHaPayload = {
  round: { start: "2026-10-12", end: "2026-10-18", days: 7, label: "12 Oct to 18 Oct (week)" },
  ranking: [
    { name: "Fruit fly", perHa: 12, cumulative: 24, areaHa: 2, threshold: 10, blocksOver: 1, blocks: 2, worst: null, over: true },
    { name: "Thrips", perHa: 3, cumulative: 6, areaHa: 2, threshold: null, blocksOver: 0, blocks: 1, worst: null, over: false },
  ],
  byBlock: [
    { name: "B1", perHa: 12, cumulative: 24, areaHa: 2, noArea: false, threshold: 10, over: true },
    { name: "B3", perHa: null, cumulative: 5, areaHa: null, noArea: true, threshold: null, over: false },
  ],
  trend: [],
  noArea: ["B3"],
  overCount: 1,
};

describe("per-hectare cards", () => {
  it("states the figure per ha and its line, and marks the pest over it", () => {
    render(<PerHaSeverityCard title="Pests" kind="pest" perHa={perHa} colorFor={() => "#000"} loading={false} />);
    const rows = screen.getAllByTestId("per-ha-row");
    expect(rows[0].textContent).toContain("12.0 / ha");
    expect(rows[0].textContent).toContain("line 10.0");
    expect(rows[0].textContent).toContain("Over line");
    expect(rows[1].textContent).toContain("No line set");
  });

  it("lists blocks without an area instead of inventing a figure", () => {
    render(<PerHaBlocksCard title="Blocks" perHa={perHa} observation="" loading={false} />);
    expect(screen.getByTestId("per-ha-no-area").textContent).toContain("B3");
  });
});
