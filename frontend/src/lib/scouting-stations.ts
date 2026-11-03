/**
 * Stations: the places a scout actually took a record, for the scouting maps.
 *
 * One station = one place (an orchard tree, a rose zone) in one scout's walk:
 * the walk is that scout's entries on one day in one block / greenhouse. Entries
 * the same scout took at the same place in the same walk merge into one station
 * (their pests/diseases add up). Stations are numbered in visit order; the order
 * uses `captureStamp`, so a 9:xx record comes before a 10:xx one.
 *
 * Pure: the maps pass how an entry finds its place and its position, and draw
 * the result (MapLibre circle/symbol layers on avocado, Leaflet markers on roses).
 */
import { captureStamp, padTime } from "@/lib/capture-time";
import type { ScoutingEntry } from "@/lib/scouting-types";

export type StationSource = "tree" | "zone" | "gps";

export interface Station {
  /** Unique: scout | date | place | station. */
  id: string;
  scout: string;
  date: string;
  /** Block / greenhouse of the walk. */
  place: string;
  /** The tree / zone the record was taken at. */
  key: string;
  lng: number;
  lat: number;
  /** Where the position came from: the place's own position, or the entry's GPS. */
  source: StationSource;
  /** 1-based visit order within the walk. */
  order: number;
  /** Stations in the whole walk. */
  walkSize: number;
  /** First / last capture time at this station (HH:MM:SS, zero-padded). */
  time: string;
  lastTime: string;
  /** Sortable first / last capture stamp. */
  stamp: string;
  lastStamp: string;
  /** Scouting Entry names merged into this station (first = earliest). */
  entries: string[];
  pests: Record<string, number>;
  diseases: Record<string, number>;
  /** Days this scout recorded here (>1 only on a collapsed station). */
  visits: number;
}

export interface StationConfig {
  /** The place's id on the map (tree / zone); null → the entry is no station. */
  keyOf: (e: ScoutingEntry) => string | null;
  /** The place's own position [lng, lat], if the map has it. */
  positionOf: (key: string, e: ScoutingEntry) => [number, number] | null;
  /** Source label for a place position (tree / zone). */
  placeSource: StationSource;
}

/** The entry's own GPS as [lng, lat]; null when absent, 0/0 or out of range. */
export function gpsOf(e: { latitude?: number | string | null; longitude?: number | string | null }): [number, number] | null {
  const lat = Number(e.latitude);
  const lng = Number(e.longitude);
  if (e.latitude == null || e.longitude == null || e.latitude === "" || e.longitude === "") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

/** Entries that are fixed-point trap checks are not part of a scout's walk. */
const isTrapCheck = (e: ScoutingEntry) => !!e.trap_scouting_entry && e.trap_scouting_entry.length > 0;

export function deriveStations(entries: ScoutingEntry[], cfg: StationConfig): Station[] {
  const ordered = entries
    .filter((e) => e.scouts_name && e.date_of_capture && !isTrapCheck(e))
    .sort((a, b) => {
      const ta = captureStamp(a);
      const tb = captureStamp(b);
      return ta < tb ? -1 : ta > tb ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  const byId = new Map<string, Station>();
  const walks = new Map<string, Station[]>();
  for (const e of ordered) {
    const key = cfg.keyOf(e);
    if (!key) continue;
    const place = e.greenhouse || e.block || "";
    const id = `${e.scouts_name}|${e.date_of_capture}|${place}|${key}`;
    let s = byId.get(id);
    if (!s) {
      const own = cfg.positionOf(key, e);
      const pos = own ?? gpsOf(e);
      if (!pos) continue;
      const walkKey = `${e.scouts_name}|${e.date_of_capture}|${place}`;
      const walk = walks.get(walkKey) ?? [];
      walks.set(walkKey, walk);
      s = {
        id,
        scout: e.scouts_name,
        date: e.date_of_capture,
        place,
        key,
        lng: pos[0],
        lat: pos[1],
        source: own ? cfg.placeSource : "gps",
        order: walk.length + 1,
        walkSize: 0,
        time: padTime(e.time_of_capture),
        lastTime: padTime(e.time_of_capture),
        stamp: captureStamp(e),
        lastStamp: captureStamp(e),
        entries: [],
        pests: {},
        diseases: {},
        visits: 1,
      };
      walk.push(s);
      byId.set(id, s);
    }
    s.entries.push(e.name);
    s.lastTime = padTime(e.time_of_capture) || s.lastTime;
    s.lastStamp = captureStamp(e) || s.lastStamp;
    for (const p of e.pests_scouting_entry || []) {
      if (p.pest) s.pests[p.pest] = (s.pests[p.pest] || 0) + (Number(p.count) || 1);
    }
    for (const d of e.diseases_scouting_entry || []) {
      if (d.disease) s.diseases[d.disease] = (s.diseases[d.disease] || 0) + 1;
    }
  }
  walks.forEach((walk) => walk.forEach((s) => (s.walkSize = walk.length)));
  return [...byId.values()];
}

/** Narrow to one scout and/or one day ("" = all). */
export function filterStations(stations: Station[], scout: string, day: string): Station[] {
  if (!scout && !day) return stations;
  return stations.filter((s) => (!scout || s.scout === scout) && (!day || s.date === day));
}

/** True when one scout has more than one walk on screen, so a number would repeat. */
export function spansWalks(stations: Station[]): boolean {
  const walkOf = new Map<string, string>();
  for (const s of stations) {
    const w = `${s.date}|${s.place}`;
    const seen = walkOf.get(s.scout);
    if (seen === undefined) walkOf.set(s.scout, w);
    else if (seen !== w) return true;
  }
  return false;
}

/**
 * One station per scout and place — the latest visit, with `visits` = the days
 * the scout recorded there. Stops months of repeat visits piling up on one tree.
 */
export function collapseLatest(stations: Station[]): Station[] {
  const best = new Map<string, Station>();
  const days = new Map<string, Set<string>>();
  for (const s of stations) {
    const k = `${s.scout}|${s.key}`;
    const set = days.get(k) ?? new Set<string>();
    set.add(s.date);
    days.set(k, set);
    const cur = best.get(k);
    if (!cur || s.lastStamp > cur.lastStamp) best.set(k, s);
  }
  return [...best.entries()].map(([k, s]) => ({ ...s, visits: days.get(k)!.size }));
}

export interface StationView {
  stations: Station[];
  /** Numbers belong to one walk, so they show only when one walk is on screen. */
  numbered: boolean;
}

/** What the layer draws for the picked scout / day. */
export function stationsInScope(
  all: Station[],
  scout: string,
  day: string,
  /** false when the rows carry no capture time (a server summary): no numbers. */
  allowNumbers = true,
): StationView {
  const picked = filterStations(all, scout, day);
  if (!allowNumbers) return { stations: collapseLatest(picked), numbered: false };
  if (!spansWalks(picked)) return { stations: picked, numbered: true };
  // Several walks per scout: numbers would repeat, so they stay off, and repeat
  // visits across days fold into the latest one.
  return { stations: collapseLatest(picked), numbered: false };
}

export interface StationFeatureProps {
  sid: string;
  color: string;
  /** Visit number as text ("" when numbers are off). */
  num: string;
  scout: string;
  visits: number;
}

export interface StationFC {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: StationFeatureProps;
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
}

export function stationFeatures(
  view: StationView,
  colorOf: (scout: string) => string,
): StationFC {
  return {
    type: "FeatureCollection",
    features: view.stations.map((s) => ({
      type: "Feature" as const,
      properties: {
        sid: s.id,
        color: colorOf(s.scout),
        num: view.numbered ? String(s.order) : "",
        scout: s.scout,
        visits: s.visits,
      },
      geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] as [number, number] },
    })),
  };
}

/** Pest / disease lines for a station card: "Thrips 4" — top first. */
export function recordedLines(rec: Record<string, number>): Array<[string, number]> {
  return Object.entries(rec).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Distinct days (newest first) and scouts of a station list — for the pickers. */
export function stationDays(stations: Station[]): string[] {
  return [...new Set(stations.map((s) => s.date))].sort().reverse();
}
export function stationScouts(stations: Station[]): string[] {
  return [...new Set(stations.map((s) => s.scout))].sort();
}
