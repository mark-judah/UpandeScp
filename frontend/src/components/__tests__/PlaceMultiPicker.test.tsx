/**
 * The multi-select farm and greenhouse picker, and the PlaceSet helpers.
 */
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
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
const option = (name: string) => within(screen.getByRole("listbox")).getByRole("option", { name });

describe("PlaceMultiPicker", () => {
  it("reads All farms when nothing is picked and lists farms with houses beneath", async () => {
    render(<Harness />);
    expect(pill().textContent).toBe("All farms");
    await userEvent.click(pill());
    const names = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.getAttribute("aria-label"));
    expect(names).toEqual(["Select all", "Chepsito", "Chepsito GH 16", "Chepsito GH 02", "Torongo", "Torongo GH 17"]);
  });

  it("unticking a house from 'all' leaves the other houses picked, farm header goes mixed", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    await userEvent.click(option("Chepsito GH 16"));
    expect(val()).toEqual({ farms: ["Torongo"], greenhouses: ["Chepsito GH 02 - KR"] });
    expect(option("Chepsito").getAttribute("aria-checked")).toBe("mixed");
    expect(pill().textContent).toBe("1 farm · 1 greenhouse");
  });

  it("ticking a farm header picks all its houses; ticking every house folds back to a farm", async () => {
    render(<Harness initial={{ farms: [], greenhouses: ["Chepsito GH 16 - KR"] }} />);
    await userEvent.click(pill());
    await userEvent.click(option("Chepsito GH 02"));
    expect(val()).toEqual({ farms: ["Chepsito"], greenhouses: [] });
    expect(pill().textContent).toBe("Chepsito");
  });

  it("Select all clears back to every farm", async () => {
    render(<Harness initial={{ farms: ["Torongo"], greenhouses: [] }} />);
    await userEvent.click(pill());
    await userEvent.click(option("Select all"));
    expect(val()).toEqual(EMPTY_PLACE_SET);
  });

  it("remembers the set per crop and restores it, reading an old single place as a one-item set", async () => {
    writePlace("Rose", { farm: "Torongo", greenhouse: "" });
    render(<Harness />);
    await vi.waitFor(() => expect(val()).toEqual({ farms: ["Torongo"], greenhouses: [] }));
    await userEvent.click(pill());
    await userEvent.click(option("Chepsito"));
    expect(readPlaceSet("Rose")).toEqual({ farms: [], greenhouses: [] }); // all picked
  });

  it("filters by search", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    await userEvent.type(screen.getByRole("combobox"), "gh17");
    const names = within(screen.getByRole("listbox")).getAllByRole("option").map((o) => o.getAttribute("aria-label"));
    expect(names).toEqual(["Torongo", "Torongo GH 17"]);
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
