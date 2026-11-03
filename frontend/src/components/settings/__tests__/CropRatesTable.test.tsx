import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CropRatesTable, hasDuplicateRates } from "@/components/settings/CropRatesTable";
import type { CropRateRow } from "@/lib/settings-api";

function Host({ initial, spy }: { initial: CropRateRow[]; spy: (r: CropRateRow[]) => void }) {
  const [rows, setRows] = useState(initial);
  return (
    <CropRatesTable
      rows={rows}
      crops={["Avocado", "Rose"]}
      onChange={(r) => {
        setRows(r);
        spy(r);
      }}
    />
  );
}

describe("CropRatesTable", () => {
  it("adds a Water row and removes it", async () => {
    const spy = vi.fn();
    render(<Host initial={[]} spy={spy} />);
    await userEvent.click(screen.getByRole("button", { name: /add rate/i }));
    expect(spy).toHaveBeenLastCalledWith([{ crop: "", basis: "Water", lower_rate_limit: 0, upper_rate_limit: 0 }]);
    expect(screen.getAllByTestId("crop-rate-row")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /remove rate/i }));
    expect(screen.queryAllByTestId("crop-rate-row")).toHaveLength(0);
  });

  it("shows the unit of each determinant and edits the limits", async () => {
    const spy = vi.fn();
    render(
      <Host
        initial={[{ crop: "Avocado", basis: "Hectarage", lower_rate_limit: 1, upper_rate_limit: 2 }]}
        spy={spy}
      />,
    );
    expect(screen.getByText("Hectarage · per 10,000 m²")).toBeTruthy();
    const upper = screen.getByLabelText("Upper rate");
    await userEvent.clear(upper);
    await userEvent.type(upper, "3");
    expect(spy).toHaveBeenLastCalledWith([
      { crop: "Avocado", basis: "Hectarage", lower_rate_limit: 1, upper_rate_limit: 3 },
    ]);
  });

  it("flags a duplicate crop + determinant", () => {
    const row = { crop: "Rose", basis: "Water" as const, lower_rate_limit: 1, upper_rate_limit: 2 };
    expect(hasDuplicateRates([row, { ...row, basis: "Hectarage" }])).toBe(false);
    render(<Host initial={[row, { ...row }]} spy={() => {}} />);
    expect(screen.getAllByText(/same crop and determinant/)).toHaveLength(2);
  });
});
