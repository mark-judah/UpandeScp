import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getHouseClusters = vi.fn();
const listPins = vi.fn();
const savePin = vi.fn();
const deletePin = vi.fn();
vi.mock("@/lib/spread-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spread-api")>()),
  getHouseClusters: (...a: unknown[]) => getHouseClusters(...a),
  listPins: (...a: unknown[]) => listPins(...a),
  savePin: (...a: unknown[]) => savePin(...a),
  deletePin: (...a: unknown[]) => deletePin(...a),
}));
const useDashboardAggregate = vi.fn();
vi.mock("@/hooks/use-dashboard-aggregate", () => ({
  useDashboardAggregate: (...a: unknown[]) => useDashboardAggregate(...a),
}));

import { HouseSpread } from "../HouseSpread";
import { GreenhouseModal } from "../GreenhouseModal";
import type { SectionCell } from "@/lib/prevalence";

const GH = "Chepsito GH 01 - KR";
const sections: SectionCell[] = Array.from({ length: 9 }, (_, j) => ({
  row: Math.floor(j / 3), col: j % 3, scouted: 6, infested: 2, pct: 33.3,
}));
const grew = {
  id: "P1", stations: ["Z1", "Z2", "Z3", "Z4", "Z5", "Z6", "Z7", "Z8", "Z9"], size: 9, centroid: [1, 1],
  rows: [0, 2], cols: [0, 2], label: "beds 1–3, zones 1–3", change: "Grew", prev_size: 6,
};
const fresh = { ...grew, id: "P2", stations: ["Z40", "Z41", "Z42", "Z43"], size: 4, label: "bed 31, zones 1–4", change: "New", prev_size: null };
const old = { ...grew, id: "P1", stations: ["Z90", "Z91", "Z92"], size: 3, label: "bed 11, zones 1–3", change: "Gone", prev_size: 3 };
const pin = {
  name: "PIN-1", title: "Thrips · front", crop: "Rose", warehouse: GH, kind: "Section", observation: "Thrips",
  obs_kind: "Pest", section_row: 0, section_col: 0, stations: [], polygon: null, shared: 1, notify: 1,
  owner: "a@x", may_edit: true,
  series: [
    { week: "2031-W29", scouted: 6, infested: 1, value: 16.7, thin: false },
    { week: "2031-W30", scouted: 6, infested: 3, value: 50, thin: false },
    { week: "2031-W31", scouted: 4, infested: 4, value: null, thin: true },
  ],
};
const props = { crop: "Rose", greenhouse: GH, kind: "pest" as const, observation: "Thrips", week: "2031-W31", sections };

beforeEach(() => {
  getHouseClusters.mockReset().mockResolvedValue({ week: "2031-W31", prev_week: "2031-W30", unit: "bed", clusters: [grew, fresh], gone: [old] });
  listPins.mockReset().mockResolvedValue([pin]);
  savePin.mockReset().mockResolvedValue({ name: "PIN-2" });
  deletePin.mockReset().mockResolvedValue({ name: "PIN-1" });
});

describe("HouseSpread", () => {
  it("lists the patches with change pills and the gone ones muted", async () => {
    render(<HouseSpread {...props} />);
    const top = await screen.findByTestId("patch-P1");
    expect(top).toHaveTextContent("9 zones");
    expect(top).toHaveTextContent("beds 1–3, zones 1–3");
    expect(top).toHaveTextContent("was 6");
    expect(within(top).getByTestId("change-pill")).toHaveAttribute("data-change", "Grew");
    expect(within(screen.getByTestId("patch-P2")).getByTestId("change-pill")).toHaveTextContent("New");
    expect(within(screen.getByTestId("gone-P1")).getByTestId("change-pill")).toHaveAttribute("data-change", "Gone");
    expect(getHouseClusters).toHaveBeenCalledWith({ crop: "Rose", warehouse: GH, observation: "Thrips", kind: "pest", week: "2031-W31" });
  });

  it("pins a patch with its frozen station list", async () => {
    render(<HouseSpread {...props} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Pin this patch" }))[0]);
    expect(screen.getByLabelText("Pin title")).toHaveValue("Thrips · beds 1–3, zones 1–3");
    fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
    await waitFor(() => expect(savePin).toHaveBeenCalledWith(expect.objectContaining({
      crop: "Rose", warehouse: GH, kind: "Patch", stations: grew.stations, observation: "Thrips",
      obs_kind: "pest", source_week: "2031-W31", shared: true,
    })));
    await waitFor(() => expect(listPins).toHaveBeenCalledTimes(2));
  });

  it("pins a section from the grid", async () => {
    render(<HouseSpread {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin Middle third · Middle" }));
    expect(screen.getByLabelText("Pin title")).toHaveValue("Thrips · Middle third · middle");
    fireEvent.click(screen.getByLabelText("Shared"));
    fireEvent.click(screen.getByRole("button", { name: "Save pin" }));
    await waitFor(() => expect(savePin).toHaveBeenCalledWith(expect.objectContaining({
      kind: "Section", section_row: 1, section_col: 1, shared: false,
    })));
  });

  it("shows each pin's weeks as a sparkline and a thin week as too few scouted", async () => {
    render(<HouseSpread {...props} />);
    expect(await screen.findByTestId("pin-sparkline-PIN-1")).toHaveAttribute("data-points", "2");
    expect(screen.getByTestId("pin-PIN-1")).toHaveTextContent("too few scouted");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete pin Thrips · front" }));
    await waitFor(() => expect(deletePin).toHaveBeenCalledWith("PIN-1"));
  });

  it("asks before deleting a pin and keeps it when the answer is no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<HouseSpread {...props} />);
    await screen.findByTestId("pin-PIN-1");
    fireEvent.click(screen.getByRole("button", { name: "Delete pin Thrips · front" }));
    expect(confirm).toHaveBeenCalled();
    expect(deletePin).not.toHaveBeenCalled();
  });

  it("never lets a slow pin list for the house it left land on the new house", async () => {
    const slow: Record<string, (p: unknown[]) => void> = {};
    listPins.mockReset().mockImplementation(
      (_c: string, wh: string) => new Promise((res) => (slow[wh] = res)),
    );
    const { rerender } = render(<HouseSpread {...props} />);
    rerender(<HouseSpread {...props} greenhouse="GH B" />);
    await act(async () => slow["GH B"]([{ ...pin, name: "PIN-B", title: "Bpin" }]));
    await act(async () => slow[GH]([{ ...pin, name: "PIN-A", title: "Apin" }]));
    expect(screen.getByTestId("pin-PIN-B")).toBeInTheDocument();
    expect(screen.queryByTestId("pin-PIN-A")).toBeNull();
  });

  it("draws no left-border strips", async () => {
    const { container } = render(<HouseSpread {...props} />);
    await screen.findByTestId("patch-P1");
    const classes = Array.from(container.querySelectorAll("[class]")).map((el) => el.getAttribute("class") || "");
    expect(classes.some((c) => /(^|\s)border-l(-|\s|$)/.test(c))).toBe(false);
  });
});

describe("GreenhouseModal spread", () => {
  it("asks for the shown observation's patches in its week", async () => {
    useDashboardAggregate.mockReturnValue({
      data: {
        topPests: [{ name: "Thrips", count: 9 }], topDiseases: [], traps: [], daily: [], scouts: 1, alerts: 0,
        prevalence: [{ kind: "pest", name: "Thrips", prevalence: 33.3, margin: 10, sections_scouted: 9,
                       sections_total: 9, reliability: "Fair", reason: null, prev: null, week: "2031-W31", sections }],
      },
    });
    render(<GreenhouseModal greenhouse={GH} fromDate="2031-07-28" toDate="2031-08-03" crop="Rose" onClose={() => {}} />);
    await screen.findByTestId("patches");
    expect(getHouseClusters).toHaveBeenCalledWith({ crop: "Rose", warehouse: GH, observation: "Thrips", kind: "pest", week: "2031-W31" });
  });
});
