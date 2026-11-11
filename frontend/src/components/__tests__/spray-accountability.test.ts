import { describe, expect, it } from "vitest";
import { accountabilityText } from "@/components/spray-plan/Accountability";
import { weekLabel } from "@/components/coverage/ZoneCoverage";
import { WEEKDAYS } from "@/components/settings/WeeklyEmailsCard";

describe("accountabilityText", () => {
  it("names the team supervisor and who scanned", () => {
    expect(
      accountabilityText({
        supervisors: [{ employee: "1", name: "Ann" }],
        scanners: [{ employee: "2", name: "Cy", at: null }],
        nobody_scanned: false,
      }),
    ).toEqual({ supervisor: "Ann", scanned: "Cy" });
  });
  it("says so when nobody scanned and when no supervisor is on the team", () => {
    expect(accountabilityText({ supervisors: [], scanners: [], nobody_scanned: true })).toEqual({
      supervisor: "no supervisor on the team",
      scanned: "nobody scanned",
    });
  });
});

describe("weekly emails and zone coverage helpers", () => {
  it("offers Monday to Sunday", () => {
    expect(WEEKDAYS).toHaveLength(7);
    expect(WEEKDAYS[0]).toBe("Monday");
  });
  it("labels a week", () => {
    expect(weekLabel("2026-10-12", "2026-10-18")).toMatch(/12 Oct.*18 Oct/);
  });
});
