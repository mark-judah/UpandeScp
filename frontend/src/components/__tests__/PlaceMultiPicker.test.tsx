/**
 * The multi-select farm and greenhouse picker, and the PlaceSet helpers.
 */
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PlaceMultiPicker } from "@/components/PlaceMultiPicker";
import {
  EMPTY_PLACE_SET, encodeNames, normalizePlaceSet, parseNames, placeSetLabel, placeSetParams,
  placeSetLeaves, readPlaceSet, writePlace, type PlaceSet,
} from "@/lib/places";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});
beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const FARMS = {
  Chepsito: ["Chepsito GH 16 - KR", "Chepsito GH 02 - KR"],
  Torongo: ["Torongo GH 17 - KR"],
};

function Harness({ initial = EMPTY_PLACE_SET }: { initial?: PlaceSet }) {
  const [value, setValue] = useState<PlaceSet>(initial);
  return (
    <>
      <PlaceMultiPicker farms={FARMS} crop="Rose" value={value} onChange={setValue} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}
const val = () => JSON.parse(screen.getByTestId("value").textContent || "{}") as PlaceSet;
const pill = () => screen.getByRole("button", { name: "Farms and greenhouses" });
const rowNames = () => Array.from(document.querySelectorAll<HTMLElement>("[data-row]")).map((r) => r.textContent);
const dot = (name: string) => screen.getByRole("checkbox", { name });
const tick = (name: string) => userEvent.click(screen.getByText(name));

describe("PlaceMultiPicker", () => {
  it("reads All farms when nothing is picked and lists farms with houses beneath, all ticked", async () => {
    render(<Harness />);
    expect(pill().textContent).toBe("All farms");
    await userEvent.click(pill());
    expect(rowNames()).toEqual(["Chepsito", "Chepsito GH 16", "Chepsito GH 02", "Torongo", "Torongo GH 17"]);
    expect(dot("Chepsito")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("3 selected")).toBeTruthy();
  });

  it("unticking a house from 'all' leaves the other houses picked, farm goes mixed", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    await tick("Chepsito GH 16");
    expect(val()).toEqual({ farms: ["Torongo"], greenhouses: ["Chepsito GH 02 - KR"] });
    expect(dot("Chepsito")).toHaveAttribute("aria-checked", "mixed");
    expect(pill().textContent).toBe("1 farm · 1 greenhouse");
  });

  it("ticking the last house folds the houses back into a farm", async () => {
    render(<Harness initial={{ farms: [], greenhouses: ["Chepsito GH 16 - KR"] }} />);
    await userEvent.click(pill());
    await tick("Chepsito GH 02");
    expect(val()).toEqual({ farms: ["Chepsito"], greenhouses: [] });
    expect(pill().textContent).toBe("Chepsito");
  });

  it("a farm row toggles all its houses", async () => {
    render(<Harness initial={{ farms: ["Torongo"], greenhouses: [] }} />);
    await userEvent.click(pill());
    await tick("Chepsito");
    expect(val()).toEqual(EMPTY_PLACE_SET); // every farm ticked = every farm
    await tick("Chepsito");
    expect(val()).toEqual({ farms: ["Torongo"], greenhouses: [] });
  });

  it("Deselect all empties the panel, then a pick starts a fresh set; every farm again after Select all", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    await userEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(screen.getByText("0 selected")).toBeTruthy();
    expect(dot("Torongo GH 17")).toHaveAttribute("aria-checked", "false");
    await tick("Torongo GH 17");
    expect(val()).toEqual({ farms: ["Torongo"], greenhouses: [] });
    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(val()).toEqual(EMPTY_PLACE_SET);
    expect(screen.getByText("3 selected")).toBeTruthy();
  });

  it("remembers the set per crop and restores it, reading an old single place as a one-item set", async () => {
    writePlace("Rose", { farm: "Torongo", greenhouse: "" });
    render(<Harness />);
    await vi.waitFor(() => expect(val()).toEqual({ farms: ["Torongo"], greenhouses: [] }));
    await userEvent.click(pill());
    await tick("Chepsito");
    expect(readPlaceSet("Rose")).toEqual({ farms: [], greenhouses: [] }); // all picked
  });

  it("filters by search, ignoring case and spaces", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    await userEvent.type(screen.getByPlaceholderText("Search farm or greenhouse"), "gh17");
    expect(rowNames()).toEqual(["Torongo", "Torongo GH 17"]);
  });

  it("is disabled while loading and shows a fixed label for one house-less farm", () => {
    const { unmount } = render(<PlaceMultiPicker farms={FARMS} crop="Rose" value={EMPTY_PLACE_SET} onChange={() => {}} disabled />);
    expect(pill()).toBeDisabled();
    unmount();
    render(<PlaceMultiPicker farms={["Solo"]} crop="Rose" value={EMPTY_PLACE_SET} onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Farms and greenhouses" })).toHaveTextContent("Solo");
  });
});

describe("PlaceSet helpers", () => {
  it("encodes one name plain and several as JSON, and parses both back", () => {
    expect(encodeNames([])).toBe("");
    expect(encodeNames(["A"])).toBe("A");
    expect(parseNames(encodeNames(["A", "B"]))).toEqual(["A", "B"]);
    expect(parseNames("A")).toEqual(["A"]);
    expect(parseNames("")).toEqual([]);
  });

  it("builds request params: farms alone, or houses with whole farms expanded", () => {
    expect(placeSetParams(EMPTY_PLACE_SET, FARMS)).toEqual({ farm: "", greenhouse: "" });
    expect(placeSetParams({ farms: ["Torongo"], greenhouses: [] }, FARMS)).toEqual({ farm: "Torongo", greenhouse: "" });
    expect(placeSetParams({ farms: ["Torongo"], greenhouses: ["Chepsito GH 16 - KR"] }, FARMS)).toEqual({
      farm: "",
      greenhouse: JSON.stringify(["Chepsito GH 16 - KR", "Torongo GH 17 - KR"]),
    });
  });

  it("normalises leaves and labels", () => {
    const leaves = placeSetLeaves({ farms: ["Torongo"], greenhouses: ["Chepsito GH 02 - KR"] }, FARMS);
    expect(normalizePlaceSet(leaves, FARMS)).toEqual({ farms: ["Torongo"], greenhouses: ["Chepsito GH 02 - KR"] });
    expect(placeSetLabel({ farms: ["A", "B"], greenhouses: [] })).toBe("2 farms");
    expect(placeSetLabel({ farms: [], greenhouses: ["Chepsito GH 16 - KR"] })).toBe("Chepsito GH 16");
  });
});
