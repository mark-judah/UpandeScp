export interface RequiredItem {
  item_code: string
  item_name?: string | null
  required_qty: number
  stock_uom?: string | null
}

export interface WorkOrder {
  name: string
  custom_greenhouse?: string | null
  custom_scheduled_application_time?: string | null
  custom_spray_type?: string | null
  custom_scope?: string | null
  custom_scope_details?: string | null
  custom_area?: number | null
  custom_water_volume?: number | null
  custom_water_ph?: number | null
  custom_water_hardness?: number | null
  custom_kit?: string | null
  wip_warehouse?: string | null
  creation?: string | null
  custom_targets?: string | null
  required_items?: RequiredItem[]
  is_forwarded?: boolean
}

export interface QrLabel {
  png_base64: string
  chemical: string
  qty: string | number
  uom?: string | null
  tgt_wh?: string | null
  src_wh?: string | null
  farm?: string | null
  greenhouse?: string | null
  wo?: string
}

export interface FarmsResponse {
  farms: string[]
  greenhouses_by_farm: Record<string, string[]>
}

export interface WorkOrdersResponse {
  work_orders: WorkOrder[]
}

export type ApproveStatus = "approved" | "already_forwarded" | "skipped" | string

export interface ApproveResponse {
  status: ApproveStatus
  se?: string
  warehouse?: string | null
  qr_labels?: QrLabel[]
  message?: string
}

export interface StopResponse {
  status: "stopped" | string
  message?: string
}

export type StatusTab = "pending" | "forwarded" | "all"

export type LogKind = "ok" | "warn" | "err" | "skip"

export interface LogLine {
  kind: LogKind
  html: string
}

export interface SpaFilters {
  fromDate: string
  toDate: string
  farm: string
  greenhouse: string
}
