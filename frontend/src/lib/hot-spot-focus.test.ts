import { beforeEach, describe, expect, it } from "vitest";

import { openHotSpotOnMap, takeHotSpotFocus } from "./hot-spot-focus";

describe("hot spot focus", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = "";
  });
  it("leaves the block and pest for the map, which reads it once", () => {
    openHotSpotOnMap("Avocado", { block: "MIMA BLK 1 - KL", kind: "pest", observation: "Mosquito Bugs" });
    expect(window.location.hash).toBe("#/avocado/observations");
    expect(takeHotSpotFocus()).toEqual({ block: "MIMA BLK 1 - KL", kind: "pest", observation: "Mosquito Bugs" });
    expect(takeHotSpotFocus()).toBeNull();
  });
});
