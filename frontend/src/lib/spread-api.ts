/**
 * Spread and pins (spec 2026-10-10-spread-and-pins): a house's patches of
 * neighbouring infested stations tracked week to week, and the pins agronomists
 * watch. Figures come from the server; the browser only formats them.
 */
import { call } from "./frappe";

export type PatchChange = "New" | "Grew" | "Shrank" | "Moved" | "Stable" | "Gone";

export interface Patch {
  id: string;
  stations: string[];
  size: number;
  /** mean (bed rank, zone rank) — rank space, not geometry */
  centroid: [number, number];
  rows: [number, number];
  cols: [number, number];
  /** "beds 20–24, zones 3–7" / "rows 4–6, trees 10–15" */
  label: string;
  change: PatchChange;
  prev_size: number | null;
}

export interface HouseClusters {
  week: string | null;
  prev_week: string | null;
  /** "row" on an avocado block (rows and trees), else "bed" */
  unit: "bed" | "row";
  clusters: Patch[];
  gone: Patch[];
}

export const NO_CLUSTERS: HouseClusters = { week: null, prev_week: null, unit: "bed", clusters: [], gone: [] };

export type PinKind = "Section" | "Patch" | "Area";

export interface PinPoint {
  week: string;
  scouted: number;
  infested: number;
  /** infested ÷ scouted × 100; null below 5 scouted ("too few scouted") */
  value: number | null;
  thin: boolean;
}

export interface ScoutingPin {
  name: string;
  title: string;
  crop: string;
  warehouse: string;
  kind: PinKind;
  observation?: string | null;
  obs_kind?: "Pest" | "Disease" | "" | null;
  stage?: string | null;
  section_row?: number;
  section_col?: number;
  stations: string[];
  polygon?: { type: string; coordinates: unknown } | null;
  source_week?: string | null;
  shared: 0 | 1;
  notify: 0 | 1;
  owner: string;
  may_edit: boolean;
  series?: PinPoint[];
}

export interface SavePinArgs {
  crop: string;
  warehouse: string;
  kind: PinKind;
  title: string;
  observation?: string;
  obs_kind?: "pest" | "disease" | "Pest" | "Disease";
  stage?: string;
  section_row?: number;
  section_col?: number;
  stations?: string[];
  polygon?: { type: "Polygon"; coordinates: number[][][] };
  source_week?: string | null;
  shared?: boolean;
  notify?: boolean;
}

const SPREAD = "upande_scp.serverscripts.scouting.spread";
const PINS = "upande_scp.serverscripts.scouting.pins";

/** "2026-W9" → "2026-W09" (the server's key); anything else passes through. */
export function isoWeekKey(week?: string | null): string | undefined {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(week || "");
  return m ? `${m[1]}-W${m[2].padStart(2, "0")}` : week || undefined;
}

export function stationWord(unit: HouseClusters["unit"]): string {
  return unit === "row" ? "trees" : "zones";
}

/** "9 zones · beds 1–3, zones 1–3" */
export function patchLine(p: Pick<Patch, "size" | "label">, unit: HouseClusters["unit"]): string {
  return `${p.size} ${stationWord(unit)} · ${p.label}`;
}

/** "50%", "too few scouted" (< 5 scouted) or "not scouted" (no week yet). */
export function pinValueLabel(pt?: PinPoint): string {
  if (!pt) return "not scouted";
  if (pt.value == null) return "too few scouted";
  return `${pt.value}%`;
}

/** Text / outline colour per change; worse = red, better = green. */
export const CHANGE_TONE: Record<PatchChange, string> = {
  New: "var(--sd-data-purple)",
  Grew: "var(--sd-data-red)",
  Shrank: "var(--sd-data-green)",
  Moved: "var(--sd-data-amber)",
  Stable: "var(--muted-foreground)",
  Gone: "var(--muted-foreground)",
};

export async function getHouseClusters(args: {
  crop: string;
  warehouse: string;
  observation: string;
  kind: "pest" | "disease";
  stage?: string;
  week?: string | null;
}): Promise<HouseClusters> {
  const r = await call<HouseClusters>(`${SPREAD}.get_house_clusters`, {
    crop: args.crop,
    warehouse: args.warehouse,
    observation: args.observation,
    kind: args.kind,
    stage: args.stage || undefined,
    week: isoWeekKey(args.week),
  });
  return r || NO_CLUSTERS;
}

export async function listPins(crop: string, warehouse: string, withSeries = true): Promise<ScoutingPin[]> {
  const r = await call<ScoutingPin[]>(`${PINS}.list_pins`, { crop, warehouse, with_series: withSeries ? 1 : 0 });
  return r || [];
}

export async function savePin(a: SavePinArgs): Promise<ScoutingPin> {
  return call<ScoutingPin>(`${PINS}.save_pin`, {
    crop: a.crop,
    warehouse: a.warehouse,
    kind: a.kind,
    title: a.title,
    observation: a.observation || undefined,
    obs_kind: a.obs_kind || undefined,
    stage: a.stage || undefined,
    section_row: a.section_row,
    section_col: a.section_col,
    stations: a.stations ? JSON.stringify(a.stations) : undefined,
    polygon: a.polygon ? JSON.stringify(a.polygon) : undefined,
    source_week: isoWeekKey(a.source_week),
    shared: a.shared === false ? 0 : 1,
    notify: a.notify === false ? 0 : 1,
  });
}

export async function deletePin(name: string): Promise<{ name: string }> {
  return call(`${PINS}.delete_pin`, { name });
}
