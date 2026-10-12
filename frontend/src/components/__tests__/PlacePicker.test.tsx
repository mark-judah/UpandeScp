/**
 * The one farm and greenhouse picker (place picker spec 2026-10-12).
 */
import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PlacePicker, type PlacePickerProps } from "@/components/PlacePicker";
import { readPlace, writePlace, type Place } from "@/lib/places";

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const FARMS = {
  Chepsito: ["Chepsito GH 16 - KR", "Chepsito GH 02 - KR"],
  Torongo: ["Torongo GH 17 - KR"],
};

function Harness({
  initial = { farm: "", greenhouse: "" },
  onPick,
  ...props
}: Partial<PlacePickerProps> & { initial?: Place; onPick?: (p: Place) => void }) {
  const [value, setValue] = useState<Place>(initial);
  return (
    <>
      <PlacePicker
        farms={FARMS}
        crop="Rose"
        value={value}
        onChange={(p) => {
          setValue(p);
          onPick?.(p);
        }}
        {...props}
      />
      <output data-testid="value">{`${value.farm}|${value.greenhouse}`}</output>
    </>
  );
}

const pill = (name = "Farm and greenhouse") => screen.getByRole("button", { name });
const options = () => within(screen.getByRole("listbox")).queryAllByRole("option").map((o) => o.textContent);

afterEach(() => vi.restoreAllMocks());

describe("PlacePicker", () => {
  it("reads All farms, then the farm, then the full house name", async () => {
    render(<Harness />);
    expect(pill()).toHaveTextContent("All farms");
    await userEvent.click(pill());
    expect(options()).toEqual(["All farms", "Chepsito", "Chepsito GH 02", "Chepsito GH 16", "Torongo", "Torongo GH 17"]);
    await userEvent.click(screen.getByRole("option", { name: "Chepsito" }));
    expect(pill()).toHaveTextContent(/^Chepsito$/);
    expect(screen.getByTestId("value")).toHaveTextContent("Chepsito|");
    await userEvent.click(pill());
    await userEvent.click(screen.getByRole("option", { name: "Torongo GH 17" }));
    expect(pill()).toHaveTextContent("Torongo GH 17");
    expect(screen.getByTestId("value")).toHaveTextContent("Torongo|Torongo GH 17 - KR");
  });

  it("searches ignoring case and spaces, keeping the farm as a header", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    const search = screen.getByRole("combobox");
    expect(search).toHaveFocus();
    await userEvent.type(search, "gh16");
    expect(options()).toEqual(["Chepsito", "Chepsito GH 16"]);
    expect(screen.getByRole("option", { name: "Chepsito GH 16" })).toHaveAttribute("title", "Chepsito GH 16 - KR");
    await userEvent.clear(search);
    await userEvent.type(search, "chep 16");
    expect(options()).toEqual(["Chepsito", "Chepsito GH 16"]);
    await userEvent.clear(search);
    await userEvent.type(search, "zzz");
    expect(options()).toEqual([]);
    expect(screen.getByText("No match")).toBeInTheDocument();
  });

  it("moves with the arrows, picks with Enter and closes with Esc", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    expect(screen.getByRole("option", { name: "All farms" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    const search = screen.getByRole("combobox");
    const activeId = search.getAttribute("aria-activedescendant");
    expect(document.getElementById(activeId!)).toHaveTextContent("Chepsito GH 02");
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("value")).toHaveTextContent("Chepsito|Chepsito GH 02 - KR");
    await userEvent.click(pill());
    await userEvent.keyboard("{ArrowUp}");
    expect(document.getElementById(screen.getByRole("combobox").getAttribute("aria-activedescendant")!))
      .toHaveTextContent("Chepsito");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("value")).toHaveTextContent("Chepsito|Chepsito GH 02 - KR");
  });

  it("Enter after a search picks the best match, not the farm shown as its context", async () => {
    render(<Harness />);
    await userEvent.click(pill());
    await userEvent.keyboard("chep 16{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("Chepsito|Chepsito GH 16 - KR");
    await userEvent.click(pill());
    await userEvent.keyboard("toron{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent(/^Torongo\|$/);
  });

  it("remembers a pick only once the page has taken it", async () => {
    function Refusing() {
      const [value] = useState<Place>({ farm: "Chepsito", greenhouse: "" });
      return <PlacePicker farms={FARMS} crop="Rose" value={value} onChange={() => {}} />;
    }
    render(<Refusing />);
    await userEvent.click(pill());
    await userEvent.click(screen.getByRole("option", { name: "Torongo" }));
    expect(readPlace("Rose")).toBeNull();
  });

  it("level farm lists farms only", async () => {
    render(<Harness level="farm" />);
    await userEvent.click(pill("Farm"));
    expect(options()).toEqual(["All farms", "Chepsito", "Torongo"]);
    await userEvent.click(screen.getByRole("option", { name: "Torongo" }));
    expect(pill("Farm")).toHaveTextContent("Torongo");
  });

  it("level greenhouse needs a house and shows farms as headers", async () => {
    render(<Harness level="greenhouse" variant="field" houseExtra={(h) => (h.includes("16") ? <span>Spray advised</span> : null)} />);
    expect(pill("Greenhouse")).toHaveTextContent("Pick a greenhouse");
    await userEvent.click(pill("Greenhouse"));
    expect(options()).toEqual(["Chepsito GH 02", "Chepsito GH 16Spray advised", "Torongo GH 17"]);
    expect(within(screen.getByRole("listbox")).getByText("Chepsito")).not.toHaveAttribute("role", "option");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("Chepsito|Chepsito GH 02 - KR");
    expect(pill("Greenhouse")).toHaveTextContent("Chepsito GH 02");
  });

  it("a single farm shows the farm: fixed at farm level, still opens for houses", async () => {
    const one = { Chepsito: FARMS.Chepsito };
    const { unmount } = render(<Harness farms={one} level="farm" />);
    expect(screen.getByRole("group", { name: "Farm" })).toHaveTextContent("Chepsito");
    expect(screen.queryByRole("button", { name: "Farm" })).not.toBeInTheDocument();
    unmount();
    render(<Harness farms={one} />);
    expect(pill()).toHaveTextContent("Chepsito");
    await userEvent.click(pill());
    expect(options()).toEqual(["Chepsito", "Chepsito GH 02", "Chepsito GH 16"]);
  });

  it("remembers the pick per crop and restores it on the next page", async () => {
    const { unmount } = render(<Harness />);
    await userEvent.click(pill());
    await userEvent.click(screen.getByRole("option", { name: "Chepsito GH 16" }));
    expect(readPlace("Rose")).toEqual({ farm: "Chepsito", greenhouse: "Chepsito GH 16 - KR" });
    expect(readPlace("Avocado")).toBeNull();
    unmount();
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("Chepsito|Chepsito GH 16 - KR"));
  });

  it("a farm-level page restores the farm and keeps the remembered house", async () => {
    writePlace("Rose", { farm: "Chepsito", greenhouse: "Chepsito GH 16 - KR" });
    render(<Harness level="farm" />);
    await waitFor(() => expect(screen.getByTestId("value")).toHaveTextContent("Chepsito|"));
    await userEvent.click(pill("Farm"));
    await userEvent.click(screen.getByRole("option", { name: "Chepsito" }));
    expect(readPlace("Rose")).toEqual({ farm: "Chepsito", greenhouse: "Chepsito GH 16 - KR" });
  });

  it("waits for the options before restoring", async () => {
    writePlace("Rose", { farm: "Torongo", greenhouse: "" });
    const { rerender } = render(<PlacePicker farms={{}} crop="Rose" value={{ farm: "", greenhouse: "" }} onChange={vi.fn()} disabled />);
    const onChange = vi.fn();
    rerender(<PlacePicker farms={FARMS} crop="Rose" value={{ farm: "", greenhouse: "" }} onChange={onChange} />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ farm: "Torongo", greenhouse: "" }));
  });

  it("ignores a remembered place the page doesn't offer and keeps it stored", async () => {
    writePlace("Rose", { farm: "Elsewhere", greenhouse: "Elsewhere GH 1 - KR" });
    const onPick = vi.fn();
    render(<Harness onPick={onPick} initial={{ farm: "Torongo", greenhouse: "" }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(onPick).not.toHaveBeenCalled();
    expect(pill()).toHaveTextContent("Torongo");
    expect(readPlace("Rose")).toEqual({ farm: "Elsewhere", greenhouse: "Elsewhere GH 1 - KR" });
  });

  it("a house the page already holds wins over the remembered one", async () => {
    writePlace("Rose", { farm: "Torongo", greenhouse: "Torongo GH 17 - KR" });
    const onPick = vi.fn();
    render(<Harness level="greenhouse" onPick={onPick} initial={{ farm: "", greenhouse: "Chepsito GH 02 - KR" }} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(onPick).not.toHaveBeenCalled();
    expect(pill("Greenhouse")).toHaveTextContent("Chepsito GH 02");
  });

  it("does not remember with remember={false}", async () => {
    writePlace("Rose", { farm: "Torongo", greenhouse: "" });
    const onPick = vi.fn();
    render(<Harness remember={false} onPick={onPick} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(onPick).not.toHaveBeenCalled();
    await userEvent.click(pill());
    await userEvent.click(screen.getByRole("option", { name: "Chepsito" }));
    expect(readPlace("Rose")).toEqual({ farm: "Torongo", greenhouse: "" });
  });

  it("works when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<Harness />);
    await userEvent.click(pill());
    await userEvent.click(screen.getByRole("option", { name: "Torongo" }));
    expect(screen.getByTestId("value")).toHaveTextContent("Torongo|");
  });
});
