/**
 * Whitelisted endpoints for the Spray Plan Creator React page.
 *
 * Backend modules:
 *  - upande_scp.serverscripts.spray_plan_creator.bootstrap
 *  - upande_scp.serverscripts.spray_plan_creator.drafts
 *  - upande_scp.serverscripts.spray_plan_creator.bulk
 *  - upande_scp.serverscripts.spray_plan_creator.approval_review
 *
 * Role gating is enforced server-side: every endpoint requires the
 * "Spray Plan Creator" role (or General Manager / Administrator). 403
 * from the call helper means the user isn't permitted; we surface that
 * in the UI as an Access-Denied banner.
 */

import { call } from "./frappe";

// ---------- Bootstrap ----------

export interface CreatorScope {
  farms: string[];
  allowed_warehouses: { name: string; custom_farm: string }[];
}

export interface CreatorGreenhouse {
  name: string;
  custom_farm: string;
  latitude: number | null;
  longitude: number | null;
  cost_center: string | null;
}

export interface CreatorKit {
  kit: string;
  warehouse: string;
  custom_farm: string;
}

export interface SprayTeamMember {
  /** Employee ID — equals the payroll number at Upande (e.g. "200986"). */
  employee: string;
  /** Pre-fetched display name; falls back to the ID server-side. */
  employee_name: string;
  designation?: string | null;
  role: string;
}

export interface CreatorSprayTeam {
  name: string;
  custom_farm: string;
  members: SprayTeamMember[];
}

export interface EmployeeSearchHit {
  employee: string;
  employee_name: string;
  designation: string | null;
  department: string | null;
  company: string | null;
  image: string | null;
}

export interface CreatorTankMix {
  name: string;
  item_name: string;
  custom_farm?: string;
}

export interface CreatorRateLimit {
  lower: number | null;
  upper: number | null;
}

export interface CreatorCostCenter {
  name: string;
  company: string | null;
  custom_farm: string | null;
}

export interface CreatorBootstrap {
  scope: CreatorScope;
  greenhouses: CreatorGreenhouse[];
  kits: CreatorKit[];
  spray_teams: CreatorSprayTeam[];
  tank_mixes: CreatorTankMix[];
  rate_limits: Record<string, CreatorRateLimit>;
  pest_catalog: { name: string }[];
  disease_catalog: { name: string }[];
  cost_centers: CreatorCostCenter[];
  weather_settings: Record<string, number>;
  irac_window_days: number;
  frac_window_days: number;
}

export async function fetchCreatorBootstrap(): Promise<CreatorBootstrap> {
  return call<CreatorBootstrap>(
    "upande_scp.serverscripts.spray_plan_creator.bootstrap.fetch_creator_bootstrap",
  );
}

// ---------- Draft CRUD ----------

export interface DraftPayloadChemical {
  item_code: string;
  item_name?: string;
  uom?: string;
  source_warehouse?: string;
  application_rate?: number;
}

export interface DraftPayloadTeamMember {
  employee: string;
  role: string;
}

export interface DraftPayload {
  custom_greenhouse: string;
  /** Optional cost-center override. Empty string or omitted = let the
   *  backend derive (Warehouse.custom_cost_center → exact → fuzzy chain). */
  custom_cost_center?: string;
  custom_classification: "Curative" | "Preventive";
  custom_preventive_reason?: string;
  custom_spray_type: string;
  custom_scope: string;
  custom_scope_details?: string;
  custom_kit?: string | null;
  custom_spray_team?: string | null;
  /** Per-plan team roster. Empty list = fall back to the master team's
   *  members at material-issue time. */
  custom_spray_plan_team_members?: DraftPayloadTeamMember[];
  custom_water_ph: number;
  custom_water_hardness: number;
  custom_water_volume: number;
  custom_area: number;
  custom_targets: string[];
  production_item: string;
  chemicals: DraftPayloadChemical[];
  custom_scheduled_application_time?: string | null;
}

export interface DraftSummary {
  name: string;
  greenhouse: string;
  classification: string;
  targets: string[];
  scheduled_date: string | null;
  chemical_count: number;
  total_water_volume: number;
  has_warnings: boolean;
  warning_text?: string | null;
}

export interface CreateDraftResponse {
  work_order: string;
  summary: unknown;
  warnings: string[];
}

export async function createDraftSprayPlan(
  payload: DraftPayload,
): Promise<CreateDraftResponse> {
  return call(
    "upande_scp.serverscripts.spray_plan_creator.drafts.create_draft_spray_plan",
    { payload: JSON.stringify(payload) },
  );
}

export async function listMyDraftPlans(): Promise<DraftSummary[]> {
  return call<DraftSummary[]>(
    "upande_scp.serverscripts.spray_plan_creator.drafts.list_my_draft_plans",
  );
}

export interface DraftPlanChemical {
  item_code: string;
  item_name?: string;
  stock_uom?: string;
  source_warehouse?: string;
  application_rate?: number;
}

export interface DraftPlanDetail {
  name: string;
  custom_greenhouse: string;
  custom_classification: string;
  custom_preventive_reason?: string | null;
  custom_spray_type: string;
  custom_scope: string;
  custom_scope_details?: string;
  custom_kit?: string | null;
  custom_spray_team?: string | null;
  custom_water_ph?: number;
  custom_water_hardness?: number;
  custom_water_volume?: number;
  custom_area?: number;
  custom_targets: string[];
  production_item?: string;
  custom_cost_center?: string;
  custom_scheduled_application_time?: string | null;
  chemicals: DraftPlanChemical[];
  custom_spray_plan_team_members: {
    employee: string;
    employee_name?: string;
    role: string;
  }[];
}

export async function fetchDraftPlan(name: string): Promise<DraftPlanDetail> {
  return call<DraftPlanDetail>(
    "upande_scp.serverscripts.spray_plan_creator.drafts.get_draft_plan",
    { name },
  );
}

export async function deleteDraftPlan(name: string): Promise<{ deleted: string }> {
  return call(
    "upande_scp.serverscripts.spray_plan_creator.drafts.delete_draft_plan",
    { name },
  );
}

// ---------- Employee search (team-member picker) ----------

export async function searchEmployees(
  query: string,
  limit: number = 20,
): Promise<EmployeeSearchHit[]> {
  return call<EmployeeSearchHit[]>(
    "upande_scp.serverscripts.spray_plan_creator.employees.search_employees",
    { query, limit },
  );
}

// ---------- Bulk ----------

export interface BulkSubmitResult {
  submitted: string[];
  skipped: { name: string; reason: string }[];
}

export async function submitDraftsForApproval(
  wo_names: string[],
): Promise<BulkSubmitResult> {
  return call<BulkSubmitResult>(
    "upande_scp.serverscripts.spray_plan_creator.bulk.submit_drafts_for_approval",
    { wo_names: JSON.stringify(wo_names) },
  );
}

export interface BulkApproveResult {
  approved: string[];
  skipped: { name: string; reason: string }[];
}

export async function approveDraftsBulk(
  wo_names: string[],
): Promise<BulkApproveResult> {
  return call<BulkApproveResult>(
    "upande_scp.serverscripts.spray_plan_creator.bulk.approve_drafts_bulk",
    { wo_names: JSON.stringify(wo_names) },
  );
}

// ---------- Approval review ----------

export interface ChemicalReview {
  item_code: string;
  item_name: string;
  application_rate: number;
  stock_uom: string;
  rate_limits: { lower: number | null; upper: number | null } | null;
  rate_status: "ok" | "below" | "above";
  irac_code: string | null;
  frac_code: string | null;
  irac_codes?: string[];
  frac_codes?: string[];
  resistance_warnings: {
    kind: "irac" | "frac";
    code: string;
    severity: "warning" | "block";
    message: string;
    prior_wo: string;
    days_ago: number;
  }[];
}

export interface ApprovalReview {
  work_order: {
    name: string;
    greenhouse: string;
    scheduled_date: string | null;
    classification: string;
    preventive_reason: string | null;
    weather_snapshot: unknown;
    team_members: { employee: string; employee_name: string; role: string }[];
    targets: string[];
  };
  chemicals: ChemicalReview[];
  plan_warnings: string[];
}

export async function getApprovalReview(woName: string): Promise<ApprovalReview> {
  return call<ApprovalReview>(
    "upande_scp.serverscripts.spray_plan_creator.approval_review.get_approval_review",
    { wo_name: woName },
  );
}

// ---------- Stock dashboard ----------

/** Chemical Store items carry a low-stock signal (qty vs. threshold). */
export interface ChemicalStoreItem {
  item_code: string;
  item_name: string;
  group: string;
  uom: string;
  qty: number;
  threshold: number;
  low: boolean;
}

/** CSU items carry an aged-stock signal (sitting > csu_max_age_days),
 *  plus a FIFO cohort breakdown so the UI can show "X expired / Y fresh"
 *  even when fresh and expired stock of the same chemical sit in the
 *  same CSU. */
export interface CsuCohort {
  /** Original deposit timestamp (ISO, server-side ``now_datetime``). */
  added_on: string;
  qty: number;
  age_days: number;
  expired: boolean;
  /** Destination greenhouse this batch was staged for — null when the
   *  inward movement isn't tied to a Work Order (manual stock entry,
   *  purchase receipt, opening balance, or pre-horizon stock). */
  greenhouse: string | null;
}

export interface CsuItem {
  item_code: string;
  item_name: string;
  group: string;
  uom: string;
  qty: number;
  threshold: number;
  aged: boolean;
  expired_qty: number;
  fresh_qty: number;
  oldest_age_days: number;
  cohorts: CsuCohort[];
}

export interface CreatorStockWarehouseStore {
  warehouse: string;
  farm: string;
  total_qty: number;
  items: ChemicalStoreItem[];
}

export interface CreatorStockWarehouseCsu {
  warehouse: string;
  farm: string;
  total_qty: number;
  aged_count: number;
  items: CsuItem[];
}

export interface CreatorStockOverview {
  csus: CreatorStockWarehouseCsu[];
  chemical_stores: CreatorStockWarehouseStore[];
  farms: string[];
  low_stock_count: number;
  aged_csu_count: number;
  csu_max_age_days: number;
  as_of: string;
}

export async function fetchCreatorStockOverview(): Promise<CreatorStockOverview> {
  return call<CreatorStockOverview>(
    "upande_scp.serverscripts.spray_plan_creator.stock.creator_stock_overview",
  );
}
