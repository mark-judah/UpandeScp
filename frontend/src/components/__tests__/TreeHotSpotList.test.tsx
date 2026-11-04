import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { TreeHotSpotList } from "../TreeHotSpotList";

const spot = {
  name: "SA-1", observation: "Mosquito Bugs", kind: "pest" as const, week: "2026-W42", band: "High" as const,
  action: "Spray advised" as const, peak: 9, trees: 7,
  label: "7 trees · rows 12–14, trees 3–9 · High, peak 9 per tree", status: "Open",
};

describe("TreeHotSpotList", () => {
  it("lists a block's hot spots and opens the map on one", async () => {
    render(<TreeHotSpotList crop="Avocado" block="MIMA BLK 1 - KL" spots={[spot]} />);
    expect(screen.getByTestId("tree-hot-spot")).toHaveTextContent("Mosquito Bugs: 7 trees, rows 12–14 · worst tree 9");
    await userEvent.click(screen.getByRole("button", { name: "Show on map" }));
    expect(window.location.hash).toBe("#/avocado/observations");
  });
  it("says so when there is none", () => {
    render(<TreeHotSpotList crop="Avocado" block="B" spots={[]} />);
    expect(screen.getByTestId("no-tree-hot-spots")).toBeInTheDocument();
  });
});
