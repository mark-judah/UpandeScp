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
}

export interface CreatorKit {
  kit: string;
  warehouse: string;
  custom_farm: string;
}

export interface CreatorSprayTeam {
  name: string;
  custom_farm: string;
  members: { employee: string; role: string }[];
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

export interface CreatorBootstrap {
  scope: CreatorScope;
  greenhouses: CreatorGreenhouse[];
  kits: CreatorKit[];
  spray_teams: CreatorSprayTeam[];
  tank_mixes: CreatorTankMix[];
  rate_limits: Record<string, CreatorRateLimit>;
  pest_catalog: { name: string }[];
  disease_catalog: { name: string }[];
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

export interface DraftPayload {
  custom_greenhouse: string;
  custom_classification: "Curative" | "Preventive";
  custom_preventive_reason?: string;
  custom_spray_type: string;
  custom_scope: string;
  custom_scope_details?: string;
  custom_kit?: string | null;
  custom_spray_team?: string | null;
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
}

export async function createDraftSprayPlan(
  payload: DraftPayload,
): Promise<{ work_order: string; summary: unknown }> {
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

export async function deleteDraftPlan(name: string): Promise<{ deleted: string }> {
  return call(
    "upande_scp.serverscripts.spray_plan_creator.drafts.delete_draft_plan",
    { name },
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
