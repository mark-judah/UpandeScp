import { describe, it, expect } from "vitest";
import {
  isOverHalf,
  summariseLoan,
  type LoanRequestItem,
  type LoanRequestV2,
} from "./loaning-api";

const item = (over: Partial<LoanRequestItem> = {}): LoanRequestItem => ({
  item_code: "AMISIL",
  requested_qty: 5,
  status: "Pending",
  ...over,
});

const req = (items: LoanRequestItem[]): LoanRequestV2 => ({
  name: "CTR-1",
  requesting_farm: "Torongo",
  lender_farm: "Kaptumbo",
  workflow_state: "Pending Approval",
  creation: "2026-08-11 10:00:00",
  owner: "a@b.c",
  items,
});

describe("isOverHalf", () => {
  it("flags a line taking more than half the lender's stock", () => {
    expect(isOverHalf(item({ requested_qty: 6, lender_on_hand: 10 }))).toBe(true);
  });

  it("does not flag exactly half", () => {
    // Half is not "more than half" — a courtesy warning shouldn't cry wolf.
    expect(isOverHalf(item({ requested_qty: 5, lender_on_hand: 10 }))).toBe(false);
  });

  it("does not flag when the snapshot is missing or zero", () => {
    expect(isOverHalf(item({ requested_qty: 5 }))).toBe(false);
    expect(isOverHalf(item({ requested_qty: 5, lender_on_hand: 0 }))).toBe(false);
  });
});

describe("summariseLoan", () => {
  it("reads from the item lines, not the workflow field", () => {
    // The lines are the truth once decisions start — a request can be part
    // approved and part declined, which no single workflow value expresses.
    expect(
      summariseLoan(req([
        item({ status: "Approved" }),
        item({ item_code: "TEPEKI", status: "Rejected" }),
      ])),
    ).toBe("1 approved, 1 declined");
  });

  it("describes an untouched request", () => {
    expect(summariseLoan(req([item(), item({ item_code: "B" })]))).toBe(
      "2 items awaiting decision",
    );
    expect(summariseLoan(req([item()]))).toBe("1 item awaiting decision");
  });

  it("describes fully decided requests", () => {
    expect(summariseLoan(req([item({ status: "Approved" })]))).toBe("all 1 approved");
    expect(summariseLoan(req([item({ status: "Rejected" })]))).toBe("all 1 declined");
  });

  it("counts a three-way split", () => {
    expect(
      summariseLoan(req([
        item({ status: "Approved" }),
        item({ item_code: "B", status: "Rejected" }),
        item({ item_code: "C", status: "Pending" }),
      ])),
    ).toBe("1 approved, 1 declined, 1 pending");
  });

  it("falls back to the workflow state with no lines", () => {
    expect(summariseLoan(req([]))).toBe("Pending Approval");
  });
});
