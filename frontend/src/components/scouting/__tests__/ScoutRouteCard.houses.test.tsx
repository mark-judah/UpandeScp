import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScoutRouteCard } from "../ScoutRouteCard";

describe("ScoutRouteCard greenhouses covered", () => {
  it("lists every greenhouse with its coverage percentage", () => {
    render(
      <ScoutRouteCard
        onClose={vi.fn()}
        trail={{
          key: "k", scoutId: "E1", name: "Lydia N", color: "#e44", greenhouse: "Karen GH 10 - KR",
          date: "2026-09-19", zonesCovered: 162, zonesTotal: 400, start: "08:00:00", end: "09:00:00", beds: [],
          houses: [
            { greenhouse: "Karen GH 10 - KR", covered: 300, total: 400, pct: 75 },
            { greenhouse: "Karen GH 11 - KR", covered: 40, total: 400, pct: 10 },
          ],
        }}
      />,
    );
    const list = screen.getByTestId("scout-card-houses");
    expect(list.textContent).toContain("Karen GH 10");
    expect(list.textContent).toContain("75%");
    expect(list.textContent).toContain("Karen GH 11");
    expect(list.textContent).toContain("10%");
    expect(list.textContent).not.toContain(" - KR");
  });
});

import { padTime } from "@/pages/RoseScouting";
describe("padTime", () => {
  it("zero-pads single-digit hours so times sort as text", () => {
    expect(padTime("9:59:00")).toBe("09:59:00");
    expect(padTime("10:00:00")).toBe("10:00:00");
    expect(padTime(null)).toBe("");
    expect(padTime("9:59:00") < padTime("10:00:00")).toBe(true);
  });
});
