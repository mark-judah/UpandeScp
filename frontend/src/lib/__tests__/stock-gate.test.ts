import { describe, expect, it } from "vitest";
import { stockShortReason } from "../store-keeper-api";

describe("stockShortReason", () => {
  it("is empty for an ok transfer", () => {
    expect(stockShortReason({ ok: true, shorts: [] })).toBe("");
    expect(stockShortReason(undefined)).toBe("");
  });
  it("names item, batch, numbers and the selected transfers holding the stock", () => {
    const r = stockShortReason({
      ok: false,
      shorts: [
        {
          item_code: "X",
          batch_no: "B1",
          warehouse: "S",
          needed: 6,
          available_when_its_turn: 4,
          short_by: 2,
          blocking_transfers: ["MAT-1"],
        },
      ],
    });
    expect(r).toBe("X batch B1: needs 6, 4 available, short by 2 (held by selected MAT-1)");
  });
});
