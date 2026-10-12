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
