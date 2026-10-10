/**
 * Scouting Alerts (thresholds spec §4–§5): the Overview's Active alerts with
 * Acknowledge, and the spray plan creator's badges. Figures come from the
 * server; the browser only formats them.
 */
import { call } from "./frappe";

export type AlertAction = "Alarming" | "Spray advised" | "Scout first" | "Hot spot";
export type AlertType = "House" | "Hot spot";
export type AlertStatus = "Open" | "Acknowledged" | "Resolved" | "Converted to plan";

export interface ScoutingAlert {
  name: string;
  crop: string;
  farm: string;
  warehouse: string;
  kind: "Pest" | "Disease";
  observation: string;
  stage?: string | null;
  iso_week: string;
  /** "Hot spot" = one section of the 3 × 3 grid clearly worse than the house. */
  alert_type?: AlertType;
  /** 0–2, or -1 for a House alert */
  section_row?: number;
  section_col?: number;
  /** "first beds · front" / "last rows · back"; empty for a House alert */
  section_label?: string | null;
  measure: "Percentage" | "Count";
  /** "%", "per zone" or "per tree" */
  unit: string;
  value: number | null;
  margin: number | null;
  reliability: "Good" | "Fair" | "Low";
  sections_scouted: number;
  sections_total: number;
  band: "Moderate" | "High";
  action: AlertAction;
  status: AlertStatus;
  acknowledged_by?: string | null;
  work_order?: string | null;
}

export type CreatorAlert = Pick<
  ScoutingAlert,
  | "name" | "warehouse" | "observation" | "stage" | "action" | "value" | "unit"
  | "reliability" | "iso_week" | "status" | "margin" | "sections_scouted" | "sections_total"
>;

const BASE = "upande_scp.serverscripts.scouting.thresholds_check";

export async function listOpenAlerts(args: {
  crop: string;
  farm?: string;
  greenhouse?: string;
}): Promise<ScoutingAlert[]> {
  const r = await call<ScoutingAlert[]>(`${BASE}.open_alerts`, {
    crop: args.crop,
    farm: args.farm || undefined,
    greenhouse: args.greenhouse || undefined,
  });
  return r || [];
}

export async function acknowledgeAlert(name: string): Promise<{ name: string; status: AlertStatus }> {
  return call(`${BASE}.acknowledge_alert`, { name });
}

/** "33.3% · ±18 · 9/9" — the figure in its unit, the margin, sections scouted.
 *  A hot spot has no margin: "80% · 5 stations in this section". */
export function alertFigureLine(
  a: Pick<ScoutingAlert, "value" | "unit" | "margin" | "sections_scouted" | "sections_total"> &
    Partial<Pick<ScoutingAlert, "alert_type">>,
): string {
  const value = a.value == null ? "—" : a.unit === "%" ? `${a.value}%` : `${a.value} ${a.unit}`;
  if (a.alert_type === "Hot spot") return `${value} · ${a.sections_scouted} stations in this section`;
  const margin = a.margin != null ? `±${a.margin}` : "too clustered to judge";
  return `${value} · ${margin} · ${a.sections_scouted}/${a.sections_total ?? 9}`;
}

/** Text colour on a tinted pill — never a border strip. */
export const ACTION_TONE: Record<AlertAction, string> = {
  "Spray advised": "var(--sd-data-red)",
  "Scout first": "var(--sd-data-amber)",
  Alarming: "var(--sd-target)",
  "Hot spot": "var(--sd-data-purple)",
};

/** The creator's badge for a greenhouse: its worst open spray action (D7). */
export function ghActionBadge(alerts?: CreatorAlert[] | null): "Spray advised" | "Scout first" | null {
  if (alerts?.some((a) => a.action === "Spray advised")) return "Spray advised";
  if (alerts?.some((a) => a.action === "Scout first")) return "Scout first";
  return null;
}
