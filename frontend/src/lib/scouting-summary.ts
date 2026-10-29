/**
 * One request for the block-grown Scouting Map: the latest entry on every hexagon / visit point
 * for the selected range, instead of every raw entry week by week (see
 * serverscripts/scouting/unit_summary.py). The rows expand back into entry-shaped objects, so the
 * map's own derive functions run on them unchanged.
 */
import { call } from "./frappe";
import type { ProcessedData, ScoutingEntry } from "./scouting-types";

export interface UnitSummary {
  aggregated: boolean;
  total_entries: number;
  scouts?: string[];
  blocks?: string[];
  /** [triad, scout, block, visits, date] */
  hex?: [string, number, number, number, string][];
  /** [lng, lat (micro-degrees), scout, block, visits, date] */
  pts?: [number, number, number, number, number, string][];
}

/** Entry-shaped rows (each had a finding, as the raw path keeps only those) for the derive functions. */
export function expandSummary(s: UnitSummary, crop: string): ScoutingEntry[] {
  if (!s?.aggregated) return [];
  const scouts = s.scouts || [];
  const blocks = s.blocks || [];
  const out: ScoutingEntry[] = [];
  const base = (name: string, sc: number, bl: number, date: string): ScoutingEntry => ({
    name,
    scouts_name: scouts[sc] || "",
    block: blocks[bl] || "",
    crop_scouted: crop,
    date_of_capture: date,
    time_of_capture: "",
    greenhouse: "",
    bed: "",
    zone: "",
    row: "",
    tree: "",
    owner: "",
    modified_by: "",
    pests_scouting_entry: [],
    diseases_scouting_entry: [],
    trap_scouting_entry: [],
    _hasAnyObs: true,
  });
  (s.hex || []).forEach(([triad, sc, bl, , date], i) =>
    out.push({ ...base(`agg-h${i}`, sc, bl, date), triad }),
  );
  (s.pts || []).forEach(([lng, lat, sc, bl, , date], i) =>
    out.push({
      ...base(`agg-p${i}`, sc, bl, date),
      latitude: (lat / 1e6).toFixed(6),
      longitude: (lng / 1e6).toFixed(6),
    }),
  );
  return out;
}

export function fetchUnitSummary(args: {
  from: string;
  to: string;
  crop?: string;
  greenhouse?: string;
}): Promise<UnitSummary> {
  return call<UnitSummary>("upande_scp.serverscripts.scouting.unit_summary.get_scouting_unit_summary", {
    from_date: args.from,
    to_date: args.to,
    ...(args.crop ? { crop: args.crop } : {}),
    ...(args.greenhouse ? { greenhouse: args.greenhouse } : {}),
  });
}

export function summaryData(s: UnitSummary, crop: string): ProcessedData {
  return { entries: expandSummary(s, crop) };
}
