/**
 * Whitelisted endpoints for the unified Spray Plan Settings page.
 *
 * Backend: upande_scp.serverscripts.spray_plan_creator.settings.*
 * Permission: General Manager / System Manager only (gated server-side).
 */

import { call } from "./frappe";

const PREFIX = "upande_scp.serverscripts.spray_plan_creator.settings";

// ───────── Spray Plan Settings ─────────

export interface SprayPlanSettings {
  intro_note: string;
  irac_rotation_window_days: number;
  frac_rotation_window_days: number;
  weather_wind_green_max_kmh: number;
  weather_wind_red_min_kmh: number;
  weather_rain_green_max_pct: number;
  weather_rain_red_min_pct: number;
  weather_temp_green_min_c: number;
  weather_temp_green_max_c: number;
  weather_temp_red_max_c: number;
  weather_temp_red_min_c: number;
  default_chemical_expense_account: string;
  bypass_owner_check: number;
  auto_cancel_enabled: number;
  auto_cancel_apply_to_backlog: number;
  auto_cancel_dormant_days: number;
  /** Read-only — stamped server-side when auto-cancel is first enabled. */
  auto_cancel_activated_on: string;
  loaning_enabled: number;
  loaning_depletion_pct: number;
  loaning_timeout_hours: number;
  progress_email_enabled: number;
  progress_email_hour: number;
  allowed_farms: { farm: string }[];
  exclude_keywords: { keyword: string }[];
}

export interface FarmCoord {
  farm: string;
  lat: number;
  lon: number;
  default_zoom: number;
}

export interface MapSettings {
  lat: number;
  lon: number;
  default_zoom: number;
  farm_coordinates: FarmCoord[];
}

export interface SettingsBundle {
  spray_plan: SprayPlanSettings;
  map_settings: MapSettings;
  farms: string[];
}

export async function fetchSettingsBundle(): Promise<SettingsBundle> {
  return call<SettingsBundle>(`${PREFIX}.get_settings_bundle`);
}

export async function saveSprayPlanSettings(
  payload: SprayPlanSettings,
): Promise<{ ok: true }> {
  return call(`${PREFIX}.save_spray_plan_settings`, {
    payload: JSON.stringify(payload),
  });
}

export async function saveFarmCoordinates(
  payload: MapSettings,
): Promise<{ ok: true }> {
  return call(`${PREFIX}.save_farm_coordinates`, {
    payload: JSON.stringify(payload),
  });
}

// ───────── Targets (pests + diseases) ─────────

export interface TargetRow {
  /** Frappe primary key — also what we send when linking on a chemical. */
  name: string;
  common_name?: string | null;
  scientific_name?: string | null;
  /** Hex color when defined on the doctype (Pest / Plant Disease). */
  pests_legend_color?: string | null;
  disease_legend_color?: string | null;
}

export interface TargetsResponse {
  pests: TargetRow[];
  diseases: TargetRow[];
}

export async function fetchTargets(): Promise<TargetsResponse> {
  return call<TargetsResponse>(`${PREFIX}.list_targets`);
}

// ───────── Codes (IRAC / FRAC / GHS) ─────────

export interface CodesResponse {
  irac: { name: string }[];
  frac: { name: string }[];
  ghs: { name: string }[];
}

export async function fetchCodes(): Promise<CodesResponse> {
  return call<CodesResponse>(`${PREFIX}.list_codes`);
}

// ───────── Chemicals ─────────

export interface ChemicalTarget {
  pest: string;
  disease: string;
}

/** Item.custom_type — drives the chemical class badge in the UI. */
export type ChemicalType = "" | "Insecticide" | "Fungicide" | "Adjuvant" | "pH Buffer";

/** Item.custom_toxicity — WHO hazard classification (I most toxic, IV least). */
export type ToxicityClass = "" | "I" | "II" | "III" | "IV";

/** Distinguishes "treats pests/diseases" items from "feeds the plant"
 *  items. Fertilizers don't get a target picker; chemicals do. */
export type ChemicalKind = "chemical" | "fertilizer";

export interface ChemicalRow {
  item_code: string;
  item_name: string;
  item_group: string;
  stock_uom: string;
  disabled: number;
  enabled: boolean;
  kind: ChemicalKind;
  custom_lower_rate_limit: number | null;
  custom_upper_rate_limit: number | null;
  custom_low_stock_threshold: number | null;
  custom_type: ChemicalType | null;
  custom_toxicity: ToxicityClass | null;
  custom_reentry_interval_hrs: number | null;
  custom_frac_moa?: string | null;
  custom_irac_moa?: string | null;
  custom_ghs_description?: string | null;
  irac: string[];
  frac: string[];
  ghs: string[];
  targets: ChemicalTarget[];
  active_ingredients: string[];
}

export interface ChemicalsResponse {
  items: ChemicalRow[];
  total: number;
  page: number;
  page_size: number;
}

export async function fetchChemicals(args: {
  query?: string;
  page?: number;
  page_size?: number;
  only_enabled?: boolean;
  kind?: ChemicalKind | "";
}): Promise<ChemicalsResponse> {
  return call<ChemicalsResponse>(`${PREFIX}.list_chemicals`, {
    query: args.query || "",
    page: args.page || 1,
    page_size: args.page_size || 50,
    only_enabled: args.only_enabled ? 1 : 0,
    kind: args.kind || "",
  });
}

export interface SaveChemicalPayload {
  enabled?: boolean;
  lower_rate_limit?: number;
  upper_rate_limit?: number;
  low_stock_threshold?: number;
  type?: ChemicalType;
  toxicity?: ToxicityClass;
  reentry_interval_hrs?: number;
  irac?: string[];
  frac?: string[];
  ghs?: string[];
  frac_moa?: string;
  irac_moa?: string;
  ghs_description?: string;
  targets?: ChemicalTarget[];
  active_ingredients?: string[];
}

export async function saveChemical(
  itemCode: string,
  payload: SaveChemicalPayload,
): Promise<{ ok: true; item_code: string }> {
  return call(`${PREFIX}.save_chemical`, {
    item_code: itemCode,
    payload: JSON.stringify(payload),
  });
}
