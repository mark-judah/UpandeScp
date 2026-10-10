import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getThresholds = vi.fn();
const saveThresholds = vi.fn();
const listCrops = vi.fn();
vi.mock("@/lib/thresholds-api", () => ({
  getThresholds: (...a: unknown[]) => getThresholds(...a),
  saveThresholds: (...a: unknown[]) => saveThresholds(...a),
  listCrops: (...a: unknown[]) => listCrops(...a),
}));

import { ThresholdsTab } from "@/components/settings/ThresholdsTab";

beforeEach(() => {
  getThresholds.mockReset().mockImplementation(async (crop: string) => ({ crop, pests: [], diseases: [] }));
  saveThresholds.mockReset().mockResolvedValue({ ok: true });
  listCrops.mockReset().mockResolvedValue(["Avocado", "Coffee", "Rose"]);
});

describe("ThresholdsTab", () => {
  it("loads the route crop and has no crop picker", async () => {
    render(<ThresholdsTab crop="Avocado" />);
    await waitFor(() => expect(getThresholds).toHaveBeenCalledWith("Avocado"));
    expect(listCrops).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Crop")).toBeNull();
  });

  it("follows the prop when the route crop changes", async () => {
    const { rerender } = render(<ThresholdsTab crop="Avocado" />);
    await waitFor(() => expect(getThresholds).toHaveBeenCalledWith("Avocado"));
    rerender(<ThresholdsTab crop="Coffee" />);
    await waitFor(() => expect(getThresholds).toHaveBeenLastCalledWith("Coffee"));
  });

  it("saves under the route crop", async () => {
    render(<ThresholdsTab crop="Avocado" />);
    const save = await screen.findByRole("button", { name: /save/i });
    await waitFor(() => expect(save).not.toBeDisabled());
    await userEvent.click(save);
    expect(saveThresholds).toHaveBeenCalledWith("Avocado", { crop: "Avocado", pests: [], diseases: [] });
  });

  const rose = {
    crop: "Rose",
    station: "zone",
    pests: [
      {
        row: "p1", pest: "Thrips", measure: "Count", count_allowed: true, invalid: false,
        low: 0, moderate: 1, high: 2,
        stages: [
          { row: "s1", stage: "Adult", reading_type: "Count", low: 0, moderate: 0, high: 0, invalid: false },
          { row: "s2", stage: "Damages", reading_type: "Checkbox", low: 0, moderate: 0, high: 0, invalid: false },
        ],
      },
      { row: "p2", pest: "Scale Insects", measure: "Percentage", count_allowed: false, invalid: false,
        low: 0, moderate: 10, high: 30, stages: [] },
    ],
    diseases: [],
  };
  const misordered = {
    row: "p3", pest: "Aphids", measure: "Percentage", count_allowed: true, invalid: true,
    low: 1, moderate: 0.4, high: 2, stages: [],
  };

  it("offers Count only where scouts record a number, with a hint", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const scale = await screen.findByTestId("threshold-row-p2");
    expect(within(scale).getByRole("radio", { name: "Count" })).toBeDisabled();
    expect(within(scale).getByTestId("count-hint-p2")).toHaveTextContent("Count needs a stage scouts record as a number");
    expect(within(screen.getByTestId("threshold-row-p1")).getByRole("radio", { name: "Count" })).not.toBeDisabled();
  });

  it("suffixes bands in the measure's unit; a tick-box stage under Count reads %", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const thrips = await screen.findByTestId("threshold-row-p1");
    expect(within(thrips).getAllByText("per zone")).toHaveLength(6);   // row + Adult
    expect(within(thrips).getAllByText("%")).toHaveLength(3);          // Damages
    await userEvent.click(within(thrips).getByRole("radio", { name: "Percentage" }));
    expect(within(thrips).queryAllByText("per zone")).toHaveLength(0);
    expect(within(thrips).getAllByText("%")).toHaveLength(9);
  });

  it("flags misordered bands inline and holds Save until they rise", async () => {
    getThresholds.mockResolvedValue({ ...rose, pests: [...rose.pests, misordered] });
    render(<ThresholdsTab crop="Rose" />);
    expect(await screen.findByTestId("band-error-p3")).toHaveTextContent("Bands must rise");
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).toBeDisabled();
    await userEvent.clear(within(screen.getByTestId("threshold-row-p3")).getByLabelText("Low"));
    expect(screen.queryByTestId("band-error-p3")).toBeNull();
    expect(save).not.toBeDisabled();
  });

  it("sends the chosen measure on save", async () => {
    getThresholds.mockResolvedValue(rose);
    render(<ThresholdsTab crop="Rose" />);
    const thrips = await screen.findByTestId("threshold-row-p1");
    await userEvent.click(within(thrips).getByRole("radio", { name: "Percentage" }));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(saveThresholds.mock.calls[0][1].pests[0].measure).toBe("Percentage");
  });
});
