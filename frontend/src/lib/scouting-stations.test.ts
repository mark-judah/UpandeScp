import { describe, expect, it } from "vitest";
import {
  collapseLatest,
  deriveStations,
  gpsOf,
  spansWalks,
  stationFeatures,
  stationsInScope,
  type StationConfig,
} from "./scouting-stations";
import type { ScoutingEntry } from "./scouting-types";

const e = (o: Record<string, unknown>): ScoutingEntry =>
  ({
    name: "E",
    date_of_capture: "2031-12-01",
    time_of_capture: "09:00:00",
    greenhouse: "",
    block: "B1",
    scouts_name: "A",
    pests_scouting_entry: [],
    diseases_scouting_entry: [],
    trap_scouting_entry: [],
    ...o,
  }) as unknown as ScoutingEntry;

const trees = new Map<string, [number, number]>([
  ["T1", [36.1, -1.1]],
  ["T2", [36.2, -1.2]],
  ["T3", [36.3, -1.3]],
]);
const cfg: StationConfig = {
  keyOf: (x) => x.tree || null,
  positionOf: (k) => trees.get(k) ?? null,
  placeSource: "tree",
};

describe("gpsOf", () => {
  it("reads numeric or string coordinates as [lng, lat]", () => {
    expect(gpsOf({ latitude: "-1.5", longitude: 36.7 })).toEqual([36.7, -1.5]);
  });
  it("rejects blanks, 0/0 and out-of-range", () => {
    expect(gpsOf({})).toBeNull();
    expect(gpsOf({ latitude: 0, longitude: 0 })).toBeNull();
    expect(gpsOf({ latitude: "", longitude: "" })).toBeNull();
    expect(gpsOf({ latitude: 95, longitude: 10 })).toBeNull();
  });
});

describe("deriveStations", () => {
  it("places a station at the tree's position, else the entry's GPS, else drops it", () => {
    const out = deriveStations(
      [
        e({ name: "1", tree: "T1" }),
        e({ name: "2", tree: "NEW", latitude: -2, longitude: 37, time_of_capture: "09:05:00" }),
        e({ name: "3", tree: "NOPE", time_of_capture: "09:06:00" }),
      ],
      cfg,
    );
    expect(out.map((s) => [s.key, s.source, s.lng, s.lat])).toEqual([
      ["T1", "tree", 36.1, -1.1],
      ["NEW", "gps", 37, -2],
    ]);
  });

  it("numbers visits with captureStamp, so 9:xx comes before 10:xx", () => {
    const out = deriveStations(
      [
        e({ name: "late", tree: "T1", time_of_capture: "10:00:33" }),
        e({ name: "early", tree: "T2", time_of_capture: "9:17:22" }),
      ],
      cfg,
    );
    expect(out.map((s) => [s.key, s.order])).toEqual([["T2", 1], ["T1", 2]]);
    expect(out[0].time).toBe("09:17:22");
    expect(out.every((s) => s.walkSize === 2)).toBe(true);
  });

  it("numbers each scout-day-place walk from 1", () => {
    const out = deriveStations(
      [
        e({ name: "1", tree: "T1" }),
        e({ name: "2", tree: "T2", time_of_capture: "09:10:00" }),
        e({ name: "3", tree: "T1", scouts_name: "B" }),
        e({ name: "4", tree: "T3", date_of_capture: "2031-12-02" }),
        e({ name: "5", tree: "T3", block: "B2", time_of_capture: "09:30:00" }),
      ],
      cfg,
    );
    const by = (scout: string, date: string, place: string) =>
      out.filter((s) => s.scout === scout && s.date === date && s.place === place).map((s) => s.order);
    expect(by("A", "2031-12-01", "B1")).toEqual([1, 2]);
    expect(by("B", "2031-12-01", "B1")).toEqual([1]);
    expect(by("A", "2031-12-02", "B1")).toEqual([1]);
    expect(by("A", "2031-12-01", "B2")).toEqual([1]);
  });

  it("merges repeat records at one place in a walk and adds what was recorded", () => {
    const out = deriveStations(
      [
        e({ name: "1", tree: "T1", pests_scouting_entry: [{ pest: "Thrips", count: 3 }], diseases_scouting_entry: [{ disease: "Rust" }] }),
        e({ name: "2", tree: "T1", time_of_capture: "09:30:00", pests_scouting_entry: [{ pest: "Thrips", count: 2 }, { pest: "Mites" }] }),
      ],
      cfg,
    );
    expect(out).toHaveLength(1);
    expect(out[0].entries).toEqual(["1", "2"]);
    expect(out[0].pests).toEqual({ Thrips: 5, Mites: 1 });
    expect(out[0].diseases).toEqual({ Rust: 1 });
    expect(out[0].lastTime).toBe("09:30:00");
  });

  it("skips trap checks and entries without a scout", () => {
    const out = deriveStations(
      [
        e({ name: "1", tree: "T1", trap_scouting_entry: [{ trap: "x", count: 1 }] }),
        e({ name: "2", tree: "T2", scouts_name: "" }),
      ],
      cfg,
    );
    expect(out).toEqual([]);
  });
});

describe("scope", () => {
  const entries = [
    e({ name: "1", tree: "T1" }),
    e({ name: "2", tree: "T2", time_of_capture: "09:10:00" }),
    e({ name: "3", tree: "T1", date_of_capture: "2031-12-02", time_of_capture: "11:00:00" }),
  ];
  const all = deriveStations(entries, cfg);

  it("shows numbered stations for a picked day", () => {
    const v = stationsInScope(all, "A", "2031-12-01");
    expect(v.numbered).toBe(true);
    expect(v.stations.map((s) => s.key)).toEqual(["T1", "T2"]);
  });

  it("across days folds repeat visits into the latest and drops the numbers", () => {
    expect(spansWalks(all)).toBe(true);
    const v = stationsInScope(all, "", "");
    expect(v.numbered).toBe(false);
    expect(v.stations).toHaveLength(2);
    const t1 = v.stations.find((s) => s.key === "T1")!;
    expect(t1.date).toBe("2031-12-02");
    expect(t1.visits).toBe(2);
  });

  it("keeps numbers off for rows with no capture time (a server summary)", () => {
    const v = stationsInScope(all, "A", "2031-12-01", false);
    expect(v.numbered).toBe(false);
    expect(v.stations).toHaveLength(2);
  });

  it("collapseLatest keeps scouts apart", () => {
    const two = deriveStations([e({ name: "1", tree: "T1" }), e({ name: "2", tree: "T1", scouts_name: "B" })], cfg);
    expect(collapseLatest(two)).toHaveLength(2);
  });

  it("builds one point per station with the scout's colour and number", () => {
    const fc = stationFeatures(stationsInScope(all, "A", "2031-12-01"), (s) => (s === "A" ? "#111111" : "#222222"));
    expect(fc.features.map((f) => [f.properties.num, f.properties.color])).toEqual([["1", "#111111"], ["2", "#111111"]]);
    expect(fc.features[0].geometry.coordinates).toEqual([36.1, -1.1]);
    const un = stationFeatures(stationsInScope(all, "", ""), () => "#000");
    expect(un.features.every((f) => f.properties.num === "")).toBe(true);
  });
});
