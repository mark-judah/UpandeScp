import { describe, expect, it } from "vitest";
import { mergeDateTime, splitDateTime, stepTime } from "./utils";

describe("splitDateTime", () => {
  it("splits a full datetime into date and HH:mm", () => {
    expect(splitDateTime("2026-07-22 06:30:00")).toEqual({
      date: "2026-07-22",
      time: "06:30",
    });
  });

  it("defaults time to 06:00 for a date-only string", () => {
    expect(splitDateTime("2026-07-22")).toEqual({
      date: "2026-07-22",
      time: "06:00",
    });
  });

  it("returns empty date and default time for an empty value", () => {
    expect(splitDateTime("")).toEqual({ date: "", time: "06:00" });
  });
});

describe("mergeDateTime", () => {
  it("merges date and time into YYYY-MM-DD HH:mm:00", () => {
    expect(mergeDateTime("2026-07-22", "06:30")).toBe("2026-07-22 06:30:00");
  });

  it("forces seconds to 00 even if time has seconds", () => {
    expect(mergeDateTime("2026-07-22", "06:30:45")).toBe("2026-07-22 06:30:00");
  });

  it("falls back to 06:00 when time is empty", () => {
    expect(mergeDateTime("2026-07-22", "")).toBe("2026-07-22 06:00:00");
  });

  it("returns empty string when date is empty", () => {
    expect(mergeDateTime("", "06:30")).toBe("");
  });
});

describe("stepTime", () => {
  it("steps minutes up by 5 and carries into the hour", () => {
    expect(stepTime("06:55", "minute", 1)).toBe("07:00");
  });

  it("wraps the whole clock at end of day when stepping minutes up", () => {
    expect(stepTime("23:55", "minute", 1)).toBe("00:00");
  });

  it("steps minutes down by 5", () => {
    expect(stepTime("06:00", "minute", -1)).toBe("05:55");
  });

  it("borrows from the hour and wraps the day when stepping minutes down", () => {
    expect(stepTime("00:00", "minute", -1)).toBe("23:55");
  });

  it("wraps hours 23 -> 00 when stepping the hour up", () => {
    expect(stepTime("23:00", "hour", 1)).toBe("00:00");
  });

  it("wraps hours 00 -> 23 when stepping the hour down", () => {
    expect(stepTime("00:00", "hour", -1)).toBe("23:00");
  });

  it("keeps minutes unchanged when stepping the hour", () => {
    expect(stepTime("06:30", "hour", 1)).toBe("07:30");
  });
});
