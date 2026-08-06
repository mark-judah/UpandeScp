export type RawEntry = Record<string, any>;

export interface PestObs {
  pest: string;
  plant_section?: string;
  stage?: string;
  count: number;
}

export interface DiseaseObs {
  disease: string;
  plant_section?: string;
  stage?: string;
  severity_level?: string;
}

export interface TrapObs {
  trap: string;
  pest?: string;
  location?: string;
  count: number;
}

export interface ScoutingEntry {
  name: string;
  date_of_capture: string;
  time_of_capture: string;
  greenhouse: string;
  bed: string;
  zone: string;
  block: string;
  row: string;
  tree: string;
  crop_scouted: string;
  owner: string;
  modified_by: string;
  scouts_name: string;
  /** Frappe ships Float fields as either number or string — consumers must
   *  parse before use. Preserved through normalization so map pages can
   *  read coords without re-querying IDB. */
  latitude?: number | string;
  longitude?: number | string;
  pests_scouting_entry: PestObs[];
  diseases_scouting_entry: DiseaseObs[];
  trap_scouting_entry: TrapObs[];
  _hasAnyObs?: boolean;
}

/**
 * Used to also carry six aggregate structures (pests/diseases/traps/
 * greenhouses/scouts/daily), computed on every ``buildScoutingData`` call.
 * Removed (R7 Task 3): no page reads them — all five scouting-dashboard
 * consumers derive their own views from ``entries`` alone. Re-verify with a
 * repo-wide grep for ``.pests``/``.diseases``/``.traps``/``.greenhouses``/
 * ``.scouts``/``.daily`` reached via a ``useScouting`` payload before
 * reintroducing any of them.
 */
export interface ProcessedData {
  entries: ScoutingEntry[];
}

export interface ChunkResponse {
  entries: RawEntry[];
  pest_colors?: Array<{ name: string; pests_legend_color?: string }>;
  disease_colors?: Array<{ name: string; disease_legend_color?: string }>;
  zones_by_greenhouse?: Record<string, number>;
  units_by_greenhouse?: Record<
    string,
    { type?: string; count: number; farm?: string; area_ha?: number }
  >;
  crops_scouted?: Array<{ name: string; crop_name: string; farms?: string[] }>;
  severity_thresholds?: Record<string, any>;
}

export interface ScoutingMeta {
  pestColors: Record<string, string>;
  diseaseColors: Record<string, string>;
  zonesByGreenhouse: Record<string, number>;
  unitsByGreenhouse: Record<
    string,
    { type?: string; count: number; farm?: string; area_ha?: number }
  >;
  cropsScouted: Array<{ name: string; crop_name: string; farms?: string[] }>;
}
