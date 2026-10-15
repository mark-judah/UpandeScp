import { describe, expect, it } from "vitest";
import { itemNeedsBatch } from "@/lib/stock-availability";

describe("itemNeedsBatch", () => {
  it("a non-batch item needs no batch and shows no picker", () => {
    expect(itemNeedsBatch({ has_batch_no: 0, batch_required: false, batches: [] })).toBe(false);
  });
  it("a batch-tracked item with batches in the store needs one", () => {
    expect(itemNeedsBatch({ has_batch_no: 1, batch_required: true, batches: [{}] })).toBe(true);
  });
  it("a batch-tracked item with ZERO batches (Amisil in Chepsito) needs none: it shows a message", () => {
    expect(itemNeedsBatch({ has_batch_no: 1, batch_required: false, batches: [] })).toBe(false);
  });
  it("falls back to the batch list for an older server", () => {
    expect(itemNeedsBatch({ has_batch_no: 1, batches: [] })).toBe(false);
    expect(itemNeedsBatch({ has_batch_no: 1, batches: [{}] })).toBe(true);
  });
});
