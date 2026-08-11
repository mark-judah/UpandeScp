import { describe, expect, it } from "vitest";
import {
  format12h,
  from12h,
  mergeDateTime,
  splitDateTime,
  stepTime,
  to12h,
} from "./utils";

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

describe("to12h / from12h", () => {
  it("maps morning hours to AM", () => {
    expect(to12h("06:30")).toEqual({ hour12: "06", minute: "30", meridiem: "AM" });
  });

  it("maps midnight to 12 AM", () => {
    expect(to12h("00:15")).toEqual({ hour12: "12", minute: "15", meridiem: "AM" });
  });

  it("maps noon to 12 PM", () => {
    expect(to12h("12:00")).toEqual({ hour12: "12", minute: "00", meridiem: "PM" });
  });

  it("maps afternoon hours to PM", () => {
    expect(to12h("13:05")).toEqual({ hour12: "01", minute: "05", meridiem: "PM" });
  });

  it("round-trips through from12h", () => {
    expect(from12h(12, 15, "AM")).toBe("00:15"); // 12 AM -> midnight
    expect(from12h(12, 0, "PM")).toBe("12:00"); // 12 PM -> noon
    expect(from12h(1, 5, "PM")).toBe("13:05");
    expect(from12h(6, 30, "AM")).toBe("06:30");
  });
});

describe("format12h", () => {
  it("drops the leading zero on the hour and appends the meridiem", () => {
    expect(format12h("06:30")).toBe("6:30 AM");
    expect(format12h("13:05")).toBe("1:05 PM");
    expect(format12h("00:00")).toBe("12:00 AM");
    expect(format12h("12:45")).toBe("12:45 PM");
  });
});
