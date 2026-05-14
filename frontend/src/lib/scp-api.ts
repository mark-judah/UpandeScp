// Typed wrappers for the SCP backend endpoints used by the floor plan page.
// Field names mirror the legacy fetch calls in www/new_application_floor_plan.js.

import { call } from "@/lib/frappe"
import type {
  ApproveResponse,
  FarmsResponse,
  StopResponse,
  WorkOrdersResponse,
} from "@/pages/spray-plan-approval/types"

export interface Greenhouse {
  name: string
  custom_farm?: string | null
}

export interface TargetOption {
  name: string
  type: string
}

export interface ChemicalOption {
  item_code: string
  item_name: string
  uom?: string
}

export interface SprayTeam {
  name: string
}

export interface Bom {
  name: string
  custom_water_ph?: number | null
  custom_water_hardness?: number | null
  custom_water_volume?: number | null
}

export interface BomItem {
  parent: string
  item_code: string
  item_name?: string
  qty: number
  uom?: string
}

export interface ObservationEntry {
  name: string
  count?: number
  stage?: string
  symbol?: string
  color?: string
  plant_section?: string
}

export interface ScoutingEntry {
  bed?: string
  zone?: string | number
  [obsType: string]: unknown
}

export interface SusceptibilityRow {
  observation: string
  type: string
  requirement_by_variety?: Record<string, "high" | "moderate" | "low" | "unknown">
}

export interface ObservationMetadata {
  type_labels?: Record<string, string>
  active_observation_types?: string[]
  all_observation_names?: Record<string, Array<{ name?: string } | string>>
}

export interface BedDataRow {
  bed?: string
  variety?: string
}

export interface ScoutingReport {
  scouting_entries?: ScoutingEntry[]
  previous_scouting_entries?: ScoutingEntry[]
  scouting_date?: string | null
  previous_scouting_date?: string | null
  observation_metadata?: ObservationMetadata
  varieties?: { name: string }[]
  susceptibility?: SusceptibilityRow[]
  spray_team_team?: SprayTeam[]
  boms?: Bom[]
  bom_items?: BomItem[]
  all_chemicals?: ChemicalOption[]
  bed_data?: BedDataRow[]
  custom_bed_numbering?: "Top to Bottom" | "Bottom to Top"
  custom_zone_numbering?: "Right to Left" | "Left to Right"
}

export interface StockBalanceResponse {
  stock_balances?: Record<string, Record<string, number>>
  item_uom_map?: Record<string, string>
  item_name_map?: Record<string, string>
}

export interface ValidationResponse {
  valid: boolean
  errors?: string[]
}

export interface CreateBomResponse {
  status: "success" | string
  bom_name?: string
  message?: string
}

export interface CreateWorkOrderResponse {
  status: "success" | string
  work_order_name?: string
  message?: string
}

export const scpApi = {
  getScoutingReport: (greenhouse: string) =>
    call<ScoutingReport>(
      "upande_scp.serverscripts.get_scouting_report.getScoutingData",
      { greenhouse },
    ),

  getTargetsForAutocomplete: () =>
    call<{ targets: TargetOption[] }>(
      "upande_scp.www.new_application_floor_plan.get_targets_for_autocomplete",
    ),

  getAllChemicals: () =>
    call<{ chemicals: ChemicalOption[]; item_uom_map?: Record<string, string> }>(
      "upande_scp.serverscripts.create_bom.getAllChemicals",
    ),

  getChemicalUom: (itemCode: string) =>
    call<{ uom: string }>(
      "upande_scp.serverscripts.create_bom.getChemicalUom",
      { item_code: itemCode },
    ),

  getBomStockBalances: (itemCodes: string[]) =>
    call<StockBalanceResponse>(
      "upande_scp.serverscripts.get_bom_stock_balances.getBomStockBalances",
      { data: JSON.stringify({ item_codes: itemCodes }) },
    ),

  createBOM: (args: {
    item: string
    greenhouse: string
    custom_water_ph: number
    custom_water_hardness: number
    items: Array<{
      item_code: string
      item_name?: string
      custom_application_rate: number
      uom: string
    }>
  }) => call<CreateBomResponse>("upande_scp.serverscripts.create_bom.createBOM", args),

  validateGuidelines: (rawData: Record<string, unknown>) =>
    call<ValidationResponse>(
      "upande_scp.serverscripts.validate_frac_irac_guidelines.validateGuidelines",
      { payload: { raw_data: rawData } },
    ),

  createApplicationWorkOrder: (rawData: Record<string, unknown>) =>
    call<CreateWorkOrderResponse>(
      "upande_scp.serverscripts.create_application_work_order.createApplicationWorkOrder",
      { payload: { raw_data: rawData } },
    ),

  sprayPlan: {
    getFarmsAndGreenhouses: () =>
      call<FarmsResponse>(
        "upande_scp.serverscripts.spray_plan_approval.get_farms_and_greenhouses",
      ),

    getPendingWorkOrders: (args: {
      from_date: string | null
      to_date: string | null
      farm: string | null
      greenhouse: string | null
    }) =>
      call<WorkOrdersResponse>(
        "upande_scp.serverscripts.spray_plan_approval.get_pending_work_orders",
        args,
      ),

    approve: (woName: string) =>
      call<ApproveResponse>(
        "upande_scp.serverscripts.spray_plan_approval.approve_single_work_order",
        { wo_name: woName },
      ),

    stop: (woName: string) =>
      call<StopResponse>(
        "upande_scp.serverscripts.spray_plan_approval.stop_single_work_order",
        { wo_name: woName },
      ),
  },
}
