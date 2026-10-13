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

  it("routes a scouting alert to its crop's overview, where active alerts are listed", () => {
    expect(
      routeForNotification({
        ...base,
        document_type: "Scouting Alert",
        link: "/scp_app#/avocado/dashboard",
      }),
    ).toBe("#/avocado/dashboard");
  });

  it("falls back to the rose overview for a scouting alert without a link", () => {
    expect(routeForNotification({ ...base, document_type: "Scouting Alert" })).toBe(
      "#/rose/dashboard",
    );
    expect(
      routeForNotification({ ...base, document_type: "Scouting Alert", link: "/app/scouting-alert/x" }),
    ).toBe("#/rose/dashboard");
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
      ["loan", "plan", "procurement", "reentry", "scouting", "stock", "transfer"],
    );
  });
});

import { busiestCategory, capCount, type CategoryCounts } from "./notifications-api";

describe("tab count helpers", () => {
  const mk = (u: Record<string, number>): CategoryCounts => ({
    counts: Object.fromEntries(
      ["loan", "transfer", "procurement", "stock", "scouting", "plan", "reentry"].map((c) => [c, { total: u[c] ?? 0, unread: u[c] ?? 0 }]),
    ) as CategoryCounts["counts"],
    total: 0,
    unread: 0,
  });
  it("caps at 99+", () => {
    expect(capCount(7)).toBe("7");
    expect(capCount(99)).toBe("99");
    expect(capCount(100)).toBe("99+");
  });
  it("finds the busiest tab, or none when nothing is unread", () => {
    expect(busiestCategory(mk({ loan: 250, transfer: 30 }))).toBe("loan");
    expect(busiestCategory(mk({}))).toBeNull();
    expect(busiestCategory(null)).toBeNull();
  });
});
