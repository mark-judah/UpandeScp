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

export interface PestAgg {
  name: string;
  counts: Array<
    PestObs & {
      date: string;
      greenhouse: string;
      bed: string;
      zone: string;
      block: string;
      row: string;
      tree: string;
    }
  >;
  stages: Record<string, number>;
  sections: Record<string, number>;
  severity: { low: number; moderate: number; high: number };
}

export interface DiseaseAgg {
  name: string;
  counts: Array<{
    date: string;
    stage?: string;
    section?: string;
    greenhouse: string;
    bed: string;
    zone: string;
    block: string;
    row: string;
    tree: string;
  }>;
  stages: Record<string, number>;
  severity: { low: number; moderate: number; high: number };
}

export interface TrapAgg {
  trap: string;
  pest: string;
  location?: string;
  counts: Array<{
    date: string;
    count: number;
    location?: string;
    greenhouse?: string;
  }>;
  total: number;
}

export interface GreenhouseAgg {
  name: string;
  pests: number;
  diseases: number;
  traps: number;
  scouts: Set<string>;
  scoutCount?: number;
  alerts: number;
}

export interface ScoutAgg {
  entries: number;
  name: string;
}

export interface DailyAgg {
  pests: number;
  diseases: number;
  traps: number;
  total: number;
}

export interface ProcessedData {
  entries: ScoutingEntry[];
  pests: Record<string, PestAgg>;
  diseases: Record<string, DiseaseAgg>;
  traps: Record<string, TrapAgg>;
  greenhouses: Record<string, GreenhouseAgg>;
  scouts: Record<string, ScoutAgg>;
  daily: Record<string, DailyAgg>;
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
