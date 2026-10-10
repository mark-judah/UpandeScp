import { call } from "./frappe";

export interface ThresholdStageRow {
  row: string;        // Frappe doc name of the Pests Stages / Disease Stages row
  stage: string;
  /** Count / Checkbox / Range — how scouts record this stage */
  reading_type: string;
  low: number;
  moderate: number;
  high: number;
  invalid?: boolean;
}

export interface ThresholdPestRow {
  row: string;        // Frappe doc name of the Pest Filter row
  pest: string;
  measure: "Percentage" | "Count";
  /** a stage scouts record as a number exists (spec D1) */
  count_allowed: boolean;
  /** bands on the row or a stage do not rise */
  invalid?: boolean;
  low: number;
  moderate: number;
  high: number;
  stages: ThresholdStageRow[];
}

export interface ThresholdDiseaseRow {
  row: string;
  disease: string;
  measure: "Percentage" | "Count";
  count_allowed: boolean;
  invalid?: boolean;
  low: number;
  moderate: number;
  high: number;
  stages: ThresholdStageRow[];
}

export interface ThresholdsBundle {
  crop: string;
  /** what a Count is "per": "zone" or "tree" */
  station?: string;
  pests: ThresholdPestRow[];
  diseases: ThresholdDiseaseRow[];
}

export async function listCrops(): Promise<string[]> {
  const r = await call<{ message?: string[] } | string[]>(
    "upande_scp.serverscripts.store.thresholds_api.list_crops",
  );
  return ((r as { message?: string[] })?.message ?? (r as string[])) || [];
}

export async function getThresholds(crop: string): Promise<ThresholdsBundle> {
  const r = await call<{ message?: ThresholdsBundle } | ThresholdsBundle>(
    "upande_scp.serverscripts.store.thresholds_api.get_thresholds",
    { crop },
  );
  return (
    ((r as { message?: ThresholdsBundle })?.message ?? (r as ThresholdsBundle)) || {
      crop,
      station: "zone",
      pests: [],
      diseases: [],
    }
  );
}

export async function saveThresholds(
  crop: string,
  payload: ThresholdsBundle,
): Promise<{ ok: boolean; updated: Record<string, number> }> {
  const r = await call<{ message?: any } | any>(
    "upande_scp.serverscripts.store.thresholds_api.save_thresholds",
    { crop, payload: JSON.stringify(payload) },
  );
  return (r as { message?: any })?.message ?? r;
}
