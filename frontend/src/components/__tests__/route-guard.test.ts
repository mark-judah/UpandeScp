/**
 * Route-level access, not just link-level.
 *
 * The sidebar hid Approvals from anyone without an approver role, but typing
 * `#/rose/approvals` into the address bar still rendered the page — it merely
 * looked empty because the server refused the data. `canOpenView` reads the
 * same nav definition the sidebar does, so App.tsx can gate the route without
 * a second copy of the rule that drifts from the first.
 */
import { describe, expect, it } from "vitest";

import { canOpenView } from "../AppSidebar";

const APPROVER = "SCP Spray Plan Approver";
const GM = "SCP General Manager";
const CREATOR = "SCP Spray Plan Creator";
const STORE_KEEPER = "SCP Chemical Store Keeper";

describe("canOpenView", () => {
  it("opens finances to a general manager on every crop, and to nobody else", () => {
    for (const crop of ["rose", "avocado", "coffee", "passion-fruit"]) {
      expect(canOpenView("finances", crop, [GM])).toBe(true);
      expect(canOpenView("finances", crop, ["System Manager"])).toBe(true);
      expect(canOpenView("finances", crop, [CREATOR, APPROVER])).toBe(false);
      expect(canOpenView("finances", crop, [])).toBe(false);
    }
  });

  it("denies approvals to a creator — the reported hole", () => {
    expect(canOpenView("approvals", "rose", [CREATOR])).toBe(false);
  });

  it("denies approvals to someone with no roles at all", () => {
    expect(canOpenView("approvals", "rose", [])).toBe(false);
  });

  it("allows approvals to an approver", () => {
    expect(canOpenView("approvals", "rose", [APPROVER])).toBe(true);
  });

  it("allows approvals to a general manager", () => {
    expect(canOpenView("approvals", "rose", [GM])).toBe(true);
  });

  it("allows an unrestricted view to anyone", () => {
    expect(canOpenView("historical", "rose", [])).toBe(true);
  });

  it("holds across crops that expose the same view", () => {
    for (const crop of ["rose", "avocado", "coffee"]) {
      expect(canOpenView("approvals", crop, [CREATOR])).toBe(false);
      expect(canOpenView("approvals", crop, [APPROVER])).toBe(true);
    }
  });

  it("a store keeper is locked out of the sections hidden from them", () => {
    // Store-Keeper-exclusive lockdown: holding ONLY that role trims the
    // sidebar to its two pages, and the router must agree.
    expect(canOpenView("approvals", "rose", [STORE_KEEPER])).toBe(false);
  });

  it("but a store keeper who is also a GM keeps full access", () => {
    expect(canOpenView("approvals", "rose", [STORE_KEEPER, GM])).toBe(true);
  });

  it("an unknown view is not denied", () => {
    // Plenty of routes are reached by drill-down rather than a sidebar link;
    // defaulting those to denied would break navigation whenever a page is
    // added without a nav entry.
    expect(canOpenView("settings" as never, "rose", [GM])).toBe(true);
  });
});

describe("canOpenView — Personnel", () => {
  it("routes match the sidebar roles", () => {
    expect(canOpenView("teams", "rose", ["SCP Spray Plan Creator"])).toBe(true);
    expect(canOpenView("sprayers", "avocado", ["SCP Spray Supervisor"])).toBe(true);
    expect(canOpenView("scouts", "rose", ["SCP Scouting User"])).toBe(true);
    expect(canOpenView("scouts", "rose", ["SCP Spray Plan Creator"])).toBe(false);
    expect(canOpenView("teams", "rose", ["SCP Scouting User"])).toBe(false);
    expect(canOpenView("coverage", "rose", [])).toBe(true);
  });
});

describe("canOpenView — Re-entry", () => {
  it("is open to production and the spray roles on every crop, and to nobody else", () => {
    for (const crop of ["rose", "avocado", "coffee", "passion-fruit"]) {
      expect(canOpenView("reentry", crop, ["SCP Production Supervisor"])).toBe(true);
      expect(canOpenView("reentry", crop, ["SCP Spray Supervisor"])).toBe(true);
      expect(canOpenView("reentry", crop, ["SCP Scout"])).toBe(false);
      expect(canOpenView("reentry", crop, [])).toBe(false);
    }
  });
});
