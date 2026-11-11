/**
 * Zone coverage of rose greenhouses (serverscripts/scouting/zone_coverage):
 * per greenhouse and ISO week, how many of its zones were scouted, how often
 * each bed was keyed and which beds fell short.
 */
import { call } from "./frappe";

export type ZoneStatus = "Full" | "Partial" | "Not scouted";

export interface ZoneDay {
  date: string;
  entries: number;
  beds: number;
  zones: number;
}

export interface UnderBed {
  bed: string;
  pct: number;
  entries: number;
  zones: string;
}

export interface ZoneRow {
  house: string;
  week_start: string;
  entries: number;
  beds_total: number;
  beds_scouted: number;
  entries_per_bed: number | null;
  zones_total: number;
  zones_scouted: number;
  zone_pct: number | null;
  status: ZoneStatus;
  beds_under: number | null;
  under: UnderBed[];
  days: ZoneDay[];
}

export interface ZoneWeek {
  week_start: string;
  week_end: string;
  /** the week is not over yet */
  partial: boolean;
  summary: { houses: number; scouted: number; full: number; partial: number; not_scouted: number };
  rows: ZoneRow[];
}

export interface ZoneCoveragePayload {
  from_date: string;
  to_date: string;
  /** a house is Full above this share of zones; a bed is under-scouted below it */
  full_pct: number;
  weeks: ZoneWeek[];
}

export function fetchZoneCoverage(args: {
  crop?: string;
  farm?: string;
  greenhouse?: string;
  from_date?: string;
  to_date?: string;
}): Promise<ZoneCoveragePayload> {
  return call<ZoneCoveragePayload>(
    "upande_scp.serverscripts.scouting.zone_coverage.get_zone_coverage",
    args,
  );
}
