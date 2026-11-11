/**
 * Farm and greenhouse names, written one way across SCP (place picker spec
 * 2026-10-12 G3), plus the per-crop memory of the last place picked (G4).
 *
 * A greenhouse's full warehouse name ("Chepsito GH 16 - KR") stays the value
 * everywhere; these only decide how it reads.
 */

/** farm → its greenhouses, the `useCropFarms` shape. */
export type FarmHouses = Record<string, string[]>;

/** A place filter: "" means "all" at that level. */
export type Place = { farm: string; greenhouse: string };

export const ALL_FARMS_LABEL = "All farms";
export const ALL_GREENHOUSES_LABEL = "All greenhouses";

/** "Chepsito GH 16 - KR" → "Chepsito GH 16": the full warehouse name minus the
 *  company suffix (" - KR"). The farm argument is accepted for old callers and
 *  ignored: the house is written in full everywhere (user preference). */
export function shortHouse(name: string, _farm?: string | null): string {
  return (name || "").replace(/\s+-\s+[A-Z]{1,4}$/, "");
}

/** The house as a pill or title reads: "Chepsito GH 16". */
export function houseLabel(name: string, _farm?: string | null): string {
  return shortHouse(name);
}

/** The farm a greenhouse belongs to: from the farm data when it lists the
 *  house, otherwise the longest farm whose name prefixes it. "" when unknown. */
export function farmOf(greenhouse: string | null | undefined, farms: FarmHouses | string[]): string {
  if (!greenhouse) return "";
  if (!Array.isArray(farms)) {
    for (const [f, houses] of Object.entries(farms)) if (houses?.includes(greenhouse)) return f;
  }
  const names = Array.isArray(farms) ? farms : Object.keys(farms);
  const g = greenhouse.toLowerCase();
  let best = "";
  for (const f of names) {
    if (f && f.length > best.length && (g === f.toLowerCase() || g.startsWith(f.toLowerCase() + " "))) best = f;
  }
  return best;
}

/** The farm a house name starts with ("Chepsito GH 16 - KR" → "Chepsito"),
 *  read from the name alone. Only for a page whose payload carries no farm
 *  data at all; anything that has the farm list uses `farmOf`. */
export function farmPrefix(greenhouse: string | null | undefined): string {
  if (!greenhouse) return "";
  const m = greenhouse.match(/^(.+?)\s+(GH|BLK)\b/i);
  return m ? m[1].trim() : greenhouse.split(" ")[0];
}

/** The greenhouses of one farm ("" = every farm), de-duplicated and sorted. */
export function housesOf(farms: FarmHouses, farm: string): string[] {
  const list = farm ? farms[farm] || [] : Object.values(farms).flat();
  return Array.from(new Set(list.filter(Boolean))).sort();
}

const compact = (s: string) => s.toLowerCase().replace(/\s+/g, "");

/** Search ignoring case and spaces: every word of the query must appear in
 *  the text, so "gh16" and "chep 16" both find "Chepsito GH 16 - KR". */
export function matchesQuery(text: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = compact(text);
  return words.every((w) => hay.includes(w));
}

// ── Remembered place, per crop (G4) ─────────────────────────────────────────

export const placeKey = (crop: string) => `scp.place.${crop || "all"}`;

/** The last place picked for the crop, or null. Never throws: storage can be
 *  missing, blocked or hold junk, and the page works without it. */
export function readPlace(crop: string): Place | null {
  try {
    const raw = window.localStorage.getItem(placeKey(crop));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    return {
      farm: typeof v.farm === "string" ? v.farm : "",
      greenhouse: typeof v.greenhouse === "string" ? v.greenhouse : "",
    };
  } catch {
    return null;
  }
}

export function writePlace(crop: string, place: Place): void {
  try {
    window.localStorage.setItem(placeKey(crop), JSON.stringify(place));
  } catch {
    /* storage blocked — the pick still applies to this page */
  }
}

// ── Multi-select places (PlaceMultiPicker) ──────────────────────────────────

/** A multi-place filter. Empty = every farm. `farms` are farms picked whole;
 *  `greenhouses` are houses picked one by one (their farm is not fully picked). */
export type PlaceSet = { farms: string[]; greenhouses: string[] };

export const EMPTY_PLACE_SET: PlaceSet = { farms: [], greenhouses: [] };

export const placeSetKey = (crop: string) => `scp.placeset.${crop || "all"}`;

export const isEmptyPlaceSet = (s: PlaceSet) => !s.farms.length && !s.greenhouses.length;

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];

/** The remembered set for the crop. Reads the old single-place key
 *  (`scp.place.<crop>`) as a one-item set when the new key is absent. */
export function readPlaceSet(crop: string): PlaceSet | null {
  try {
    const raw = window.localStorage.getItem(placeSetKey(crop));
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === "object") return { farms: strings(v.farms), greenhouses: strings(v.greenhouses) };
    }
  } catch {
    /* fall through to the old key */
  }
  const old = readPlace(crop);
  if (!old) return null;
  if (old.greenhouse) return { farms: [], greenhouses: [old.greenhouse] };
  if (old.farm) return { farms: [old.farm], greenhouses: [] };
  return EMPTY_PLACE_SET;
}

export function writePlaceSet(crop: string, set: PlaceSet): void {
  try {
    window.localStorage.setItem(placeSetKey(crop), JSON.stringify(set));
  } catch {
    /* storage blocked — the pick still applies to this page */
  }
}

/** Fold a set of picked leaves (houses, plus houseless farms) back into
 *  whole farms and loose houses. */
export function normalizePlaceSet(leaves: ReadonlySet<string>, farms: FarmHouses): PlaceSet {
  const outFarms: string[] = [];
  const outHouses: string[] = [];
  for (const [f, houses] of Object.entries(farms)) {
    if (!houses.length) {
      if (leaves.has(`f:${f}`)) outFarms.push(f);
      continue;
    }
    const picked = houses.filter((h) => leaves.has(`h:${h}`));
    if (picked.length === houses.length) outFarms.push(f);
    else outHouses.push(...picked);
  }
  return { farms: outFarms, greenhouses: outHouses };
}

/** The leaves a set stands for; empty set = everything. */
export function placeSetLeaves(set: PlaceSet, farms: FarmHouses): Set<string> {
  const out = new Set<string>();
  const all = isEmptyPlaceSet(set);
  for (const [f, houses] of Object.entries(farms)) {
    const whole = all || set.farms.includes(f);
    if (!houses.length) {
      if (whole) out.add(`f:${f}`);
      continue;
    }
    for (const h of houses) if (whole || set.greenhouses.includes(h)) out.add(`h:${h}`);
  }
  return out;
}

/** One name stays a plain string (old single-param callers); several travel as
 *  a JSON list, which the server's `parse_names` reads. */
export function encodeNames(names: string[]): string {
  return names.length === 0 ? "" : names.length === 1 ? names[0] : JSON.stringify(names);
}

/** The `farm` / `greenhouse` request params for a set: farms alone when only
 *  whole farms are picked, otherwise the houses (whole farms expanded) with no
 *  farm — so the server's farm AND greenhouse filter keeps its meaning. */
export function placeSetParams(set: PlaceSet, farms: FarmHouses): { farm: string; greenhouse: string } {
  if (isEmptyPlaceSet(set)) return { farm: "", greenhouse: "" };
  if (!set.greenhouses.length) return { farm: encodeNames(set.farms), greenhouse: "" };
  const houses = new Set(set.greenhouses);
  for (const f of set.farms) for (const h of farms[f] || []) houses.add(h);
  return { farm: "", greenhouse: encodeNames([...houses]) };
}

/** Pill text: "All farms", "Chepsito", "Chepsito GH 16", "2 farms · 1 greenhouse". */
export function placeSetLabel(set: PlaceSet, allLabel = ALL_FARMS_LABEL): string {
  const nf = set.farms.length;
  const nh = set.greenhouses.length;
  if (!nf && !nh) return allLabel;
  if (nf === 1 && !nh) return set.farms[0];
  if (!nf && nh === 1) return houseLabel(set.greenhouses[0]);
  const parts: string[] = [];
  if (nf) parts.push(`${nf} farm${nf > 1 ? "s" : ""}`);
  if (nh) parts.push(`${nh} greenhouse${nh > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

/** Inverse of `encodeNames`: "" → [], "A" → ["A"], '["A","B"]' → ["A","B"]. */
export function parseNames(v: string | null | undefined): string[] {
  const t = (v || "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      const a = JSON.parse(t);
      if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string" && !!x);
    } catch {
      /* a name that merely starts with "[" */
    }
  }
  return [t];
}
