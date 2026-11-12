import { describe, expect, it } from "vitest";
import {
  batteryPct, canSeeItMonitor, compareVersions, filterDevices, formatBytes, normaliseDataFlow, normaliseDevice,
  normaliseLogin, normaliseOverview, overviewTiles, queueRows, relativeTime, seriesOf, shortPath, toWide, topSeries,
} from "./it-monitor-api";
import { canOpenView } from "@/components/AppSidebar";
import { routeHash } from "./router";

describe("role gating", () => {
  it("admits SCP IT, System Manager and SCP General Manager only", () => {
    expect(canSeeItMonitor(["SCP IT"])).toBe(true);
    expect(canSeeItMonitor(["System Manager"])).toBe(true);
    expect(canSeeItMonitor(["SCP General Manager"])).toBe(true);
    expect(canSeeItMonitor(["SCP Scout", "SCP Spray Plan Creator"])).toBe(false);
    expect(canSeeItMonitor([])).toBe(false);
  });
  it("gates the #/it route off the sidebar definition, in every crop", () => {
    for (const crop of ["rose", "avocado", "coffee", "passion-fruit"]) {
      expect(canOpenView("it", crop, ["SCP IT"])).toBe(true);
      expect(canOpenView("it", crop, ["SCP Scout"])).toBe(false);
    }
  });
  it("the route hash has no crop segment", () => {
    expect(routeHash({ crop: "avocado", view: "it" })).toBe("#/it");
  });
});

describe("formatting", () => {
  it("relative time", () => {
    const now = new Date("2026-11-12T12:00:00");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("2026-11-12 11:59:30", now)).toBe("just now");
    expect(relativeTime("2026-11-12 11:15:00", now)).toBe("45 min ago");
    expect(relativeTime("2026-11-12 07:00:00", now)).toBe("5 h ago");
    expect(relativeTime("2026-11-09 12:00:00", now)).toBe("3 d ago");
    expect(relativeTime("2026-08-01 12:00:00", now)).toBe("3 mo ago");
  });
  it("bytes and battery", () => {
    expect(formatBytes(null)).toBe("-");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatBytes(120 * 1024 ** 2)).toBe("120 MB");
    expect(batteryPct(0.156)).toBe(16);
    expect(batteryPct(-1)).toBeNull();
    expect(batteryPct(null)).toBeNull();
  });
  it("compares dotted versions numerically", () => {
    expect(compareVersions("1.0.9", "1.0.12")).toBe(-1);
    expect(compareVersions("1.0.12", "1.0.12")).toBe(0);
    expect(compareVersions("2.0", "1.9.9")).toBe(1);
    expect(compareVersions(null, "1.0.0")).toBe(-1);
  });
  it("shortens request URLs to the path", () => {
    expect(shortPath("https://x.com/api/method/a.b?x=1")).toBe("/api/method/a.b");
    expect(shortPath(null)).toBe("");
  });
});

describe("normalisers survive missing and odd fields", () => {
  it("device", () => {
    const d = normaliseDevice({ install_id: "i1", status: "weird", battery_level: "0.15", queues: '{"scouting":{"pending":3,"failed":1}}', stuck_total: "2" });
    expect(d.status).toBe("Unknown");
    expect(d.battery_level).toBe(0.15);
    expect(d.stuck_total).toBe(2);
    expect(d.queues.scouting).toMatchObject({ pending: 3, failed: 1, held: 0 });
    expect(queueRows(d.queues)[0].stuck).toBe(1);
    expect(normaliseDevice(null).install_id).toBe("");
  });
  it("overview defaults to zeros and builds tiles in order", () => {
    const o = normaliseOverview({ devices: { total: 4, behind: 1, with_stuck: 2 }, stuck_by_queue: { scouting: "2" } });
    expect(o.devices.dormant).toBe(0);
    expect(o.stuck_by_queue.scouting).toBe(2);
    const t = overviewTiles(o);
    expect(t.map((x) => x.key)).toEqual(["total", "active_24h", "behind", "dormant", "low_battery", "low_storage", "with_stuck"]);
    expect(t.find((x) => x.key === "behind")!.warn).toBe(true);
    expect(t.find((x) => x.key === "dormant")!.warn).toBe(false);
  });
});

describe("device filtering", () => {
  const mk = (o: Record<string, unknown>) => normaliseDevice({ install_id: "x", ...o });
  const rows = [
    mk({ install_id: "a", user_full_name: "Wanjiku", farm: "Torongo", status: "Current", stuck_total: 0, app_version: "1.0.12" }),
    mk({ install_id: "b", user_full_name: "Otieno", farm: "Chepsito", status: "Behind", stuck_total: 3, device_model: "Galaxy A14" }),
  ];
  it("filters by farm, status, stuck and free text", () => {
    expect(filterDevices(rows, { farm: "Chepsito" }).map((d) => d.install_id)).toEqual(["b"]);
    expect(filterDevices(rows, { farm: JSON.stringify(["Chepsito", "Nowhere"]) }).map((d) => d.install_id)).toEqual(["b"]);
    expect(filterDevices(rows, { farm: JSON.stringify(["Chepsito", rows[0].farm ?? ""]) })).toHaveLength(2);
    expect(filterDevices(rows, { status: "Current" }).map((d) => d.install_id)).toEqual(["a"]);
    expect(filterDevices(rows, { stuck_only: true }).map((d) => d.install_id)).toEqual(["b"]);
    expect(filterDevices(rows, { search: "galaxy" }).map((d) => d.install_id)).toEqual(["b"]);
    expect(filterDevices(rows, { search: "wanj" }).map((d) => d.install_id)).toEqual(["a"]);
    expect(filterDevices(rows, {})).toHaveLength(2);
  });
});

describe("data flow shaping", () => {
  it("pivots long rows to wide and wide rows stay wide", () => {
    const long = toWide([
      { date: "2026-11-02", scout: "A", count: 5 },
      { date: "2026-11-01", scout: "A", count: 2 },
      { date: "2026-11-01", scout: "B", count: 7 },
    ]);
    expect(long).toEqual([
      { date: "2026-11-01", A: 2, B: 7 },
      { date: "2026-11-02", A: 5 },
    ]);
    expect(toWide([{ date: "2026-11-01", Synced: 3, Held: "1" }])).toEqual([{ date: "2026-11-01", Synced: 3, Held: 1 }]);
    expect(toWide(undefined)).toEqual([]);
  });
  it("folds the tail of many scouts into Others", () => {
    const pts = [{ date: "d", a: 10, b: 9, c: 1, d: 2 }];
    expect(seriesOf(pts)).toEqual(["a", "b", "d", "c"]);
    const t = topSeries(pts, 2);
    expect(t.series).toEqual(["a", "b", "Others"]);
    expect(t.points[0].Others).toBe(3);
  });
  it("shapes the server's data_flow payload", () => {
    const f = normaliseDataFlow({
      daily: [
        { date: "2026-11-01", pest_photos: 3, csu_scans: 0, spray_synced: 2, spray_held: 1 },
        { date: "2026-11-02", pest_photos: 0, csu_scans: 0, spray_synced: 0, spray_held: 0 },
      ],
      scouting_by_scout: [
        { date: "2026-11-01", scout: "HR-1", scout_name: "Wanjiku", entries: 40 },
        { date: "2026-11-02", scout: "HR-1", scout_name: "Wanjiku", entries: 10 },
      ],
      device_queues: { scouting: { pending: 4, stuck: 1, devices: 2 } },
    });
    expect(f.scouts).toEqual(["Wanjiku"]);
    expect(f.scouting).toEqual([{ date: "2026-11-01", Wanjiku: 40 }, { date: "2026-11-02", Wanjiku: 10 }]);
    expect(f.pest_photos[0]).toEqual({ date: "2026-11-01", Photos: 3 });
    expect(f.csu_scans).toEqual([]); // nothing in the period: the chart shows its empty state
    expect(f.spray_sessions[0]).toMatchObject({ Synced: 2, Held: 1, Refused: 0 });
    expect(f.queues).toEqual([{ name: "scouting", pending: 4, stuck: 1, devices: 2 }]);
    expect(normaliseDataFlow(null).queues).toEqual([]);
  });
  it("reads logins from {rows}", () => {
    const l = normaliseLogin({ ts: "2026-11-12 08:00:00", user: "u", operation: "Login", status: "Failed", subject: "bad pw", device_model: "A14", source: "device" });
    expect(l).toMatchObject({ status: "Failed", note: "bad pw", device: "A14" });
  });
});
