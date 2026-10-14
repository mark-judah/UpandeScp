/** Payload of dashboard_aggregates.quality (data quality spec, roadmap item 7). */

export type FlagKind =
  | "map_offset"
  | "not_scouted_recently"
  | "thin_coverage"
  | "too_fast"
  | "nothing_found"
  | "off_zone"
  | "duplicates"
  | "metadata_gap";

export interface QualityFlag {
  kind: FlagKind;
  subject: "house" | "scout";
  name: string;
  label: string;
  value: number;
  threshold: number;
  unit: string;
  score: number;
  detail: string;
}

export interface QualityHouse {
  house: string;
  week: string | null;
  /** True when the house's only week in range is the current, unfinished one. */
  weekPartial: boolean;
  /** Days between the coverage week's Sunday and the range end. */
  staleDays: number | null;
  stations: number | null;
  stationsScouted: number | null;
  coveragePct: number | null;
  sectionsScouted: number | null;
  entries: number;
  scouts: number;
  nothingFoundPct: number | null;
  fixes: number;
  metadataPct: number | null;
  offZonePct: number | null;
  medianDistance: number | null;
  p90Distance: number | null;
  gpsReliable: boolean;
}

export interface QualityScout {
  scout: string;
  scoutName: string;
  entries: number;
  activeDays: number;
  entriesPerHour: number | null;
  bedsPerDay: number | null;
  /** Zone-to-zone moves; too fast is a share of these. */
  moves: number;
  tooFastPct: number | null;
  nothingFoundPct: number | null;
  fixes: number;
  metadataPct: number | null;
  offZonePct: number | null;
  /** Off-zone share of the houses this scout worked, weighted by their fixes there. */
  houseOffZonePct: number | null;
  duplicates: number;
  duplicatePct: number | null;
  medianSyncMin: number | null;
  syncSample: number;
}

export interface QualityPayload {
  kpis: {
    entries: number;
    houses: number;
    scouts: number;
    coveragePct: number | null;
    offZonePct: number | null;
    zoneMapSuspect: boolean;
    tooFastPct: number | null;
    metadataPct: number | null;
    nothingFoundPct: number | null;
  };
  /** True when the server capped the range at `thresholds.maxRangeDays`. */
  clamped: boolean;
  range: { from_date: string; to_date: string };
  flags: QualityFlag[];
  houses: QualityHouse[];
  scouts: QualityScout[];
  thresholds: {
    mapOffsetMedianM: number;
    minFixes: number;
    thinCoveragePct: number;
    tooFastPct: number;
    tooFastSeconds: number;
    nothingFoundExcess: number;
    nothingFoundMinEntries: number;
    offZoneExcess: number;
    zoneMapSuspectPct: number;
    duplicatePct: number;
    metadataMinPct: number;
    staleDays: number;
    maxRangeDays: number;
    syncDelayFrom: string;
  };
}
