import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const suggestTransferBatches = vi.fn();
const applyTransferBatches = vi.fn();
const clearTransferBatches = vi.fn();

vi.mock("@/lib/store-keeper-api", () => ({
  suggestTransferBatches: (...a: unknown[]) => suggestTransferBatches(...a),
  applyTransferBatches: (...a: unknown[]) => applyTransferBatches(...a),
  clearTransferBatches: (...a: unknown[]) => clearTransferBatches(...a),
}));

import { TransferBatchPanel } from "@/components/store/TransferBatchPanel";

const row = (idx: number, batch_no: string) => ({
  idx,
  item_code: "1110009",
  item_name: "IMPULSE EC500",
  qty: 0.5,
  uom: "Litre",
  warehouse: "Store",
  to_warehouse: "CSU",
  batch_no,
  needs_batch: true,
  settled: !!batch_no,
  expired: false,
  suggestion: batch_no ? null : "B2",
  picks: [],
  short: 0,
  options: [],
});

describe("TransferBatchPanel unassign", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTransferBatches.mockResolvedValue({ updated: 1 });
    suggestTransferBatches
      .mockResolvedValueOnce({ rows: [row(1, "B1"), row(2, "B2")], needs_batch: 2, unfilled: 0 })
      .mockResolvedValue({ rows: [row(1, ""), row(2, "B2")], needs_batch: 2, unfilled: 0 });
  });

  it("unassigns one row, then reloads and tells the parent", async () => {
    const onApplied = vi.fn();
    render(<TransferBatchPanel name="MAT-STE-1" onApplied={onApplied} />);
    const buttons = await screen.findAllByRole("button", { name: /unassign/i });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]);
    await waitFor(() => expect(clearTransferBatches).toHaveBeenCalledWith("MAT-STE-1", [1]));
    await waitFor(() => expect(suggestTransferBatches).toHaveBeenCalledTimes(2));
    expect(onApplied).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /unassign/i })).toHaveLength(1));
  });

  it("clears every batch at once", async () => {
    render(<TransferBatchPanel name="MAT-STE-1" />);
    await userEvent.click(await screen.findByRole("button", { name: /clear all batches/i }));
    await waitFor(() => expect(clearTransferBatches).toHaveBeenCalledWith("MAT-STE-1", undefined));
  });
});

describe("TransferBatchPanel zero-valued batches", () => {
  it("shows an unvalued batch disabled and never selectable", async () => {
    suggestTransferBatches.mockReset();
    suggestTransferBatches.mockResolvedValue({
      rows: [
        {
          ...row(1, ""),
          suggestion: "OK1",
          options: [
            { batch_no: "OK1", qty: 5, expiry_date: null, days_to_expiry: null, placeholder: false, status: "undated" },
            { batch_no: "FREE1", qty: 5, expiry_date: null, days_to_expiry: null, placeholder: false, zero_valued: true, status: "unvalued" },
          ],
        },
      ],
      needs_batch: 1,
      unfilled: 0,
    });
    render(<TransferBatchPanel name="MAT-STE-1" />);
    await userEvent.click(await screen.findByRole("combobox"));
    const free = (await screen.findByText("FREE1")).closest("button")!;
    expect(free).toBeDisabled();
    expect(screen.getAllByText(/No valuation rate/).length).toBeGreaterThan(0);
  });
});
