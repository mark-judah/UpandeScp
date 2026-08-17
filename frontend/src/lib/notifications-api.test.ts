import { describe, it, expect } from "vitest";
import {
  CATEGORY_LABEL,
  relativeTime,
  routeForNotification,
  type ScpNotification,
} from "./notifications-api";

const base: ScpNotification = {
  name: "n1",
  subject: "Loan requested",
  read: 0,
  creation: "2026-08-11 10:00:00",
};

describe("routeForNotification", () => {
  it("routes a loan notification to the loaning page", () => {
    expect(
      routeForNotification({ ...base, document_type: "Chemical Transfer Request" }),
    ).toBe("#/rose/chemical-loaning");
  });

  it("returns null for a doctype with no page, rather than a dead link", () => {
    expect(routeForNotification({ ...base, document_type: "Sales Order" })).toBeNull();
    expect(routeForNotification(base)).toBeNull();
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-08-11T12:00:00");

  it("reads just now under a minute", () => {
    expect(relativeTime("2026-08-11 11:59:30", now)).toBe("just now");
  });

  it("counts minutes, hours and days", () => {
    expect(relativeTime("2026-08-11 11:30:00", now)).toBe("30m ago");
    expect(relativeTime("2026-08-11 09:00:00", now)).toBe("3h ago");
    expect(relativeTime("2026-08-09 12:00:00", now)).toBe("2d ago");
  });

  it("falls back to a date beyond a week", () => {
    // Not "23d ago" — at that distance the actual date is more useful.
    expect(relativeTime("2026-07-19 12:00:00", now)).toMatch(/Jul/);
  });

  it("never renders a negative age for a clock-skewed future stamp", () => {
    expect(relativeTime("2026-08-11 12:05:00", now)).toBe("just now");
  });

  it("returns empty for junk rather than 'Invalid Date'", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
    expect(relativeTime("", now)).toBe("");
  });
});

describe("CATEGORY_LABEL", () => {
  it("covers every category the server can send", () => {
    // Mirrors notifications.CATEGORIES — a missing label renders as blank.
    expect(Object.keys(CATEGORY_LABEL).sort()).toEqual(
      ["loan", "procurement", "stock", "transfer"],
    );
  });
});
