/**
 * Scouting Alerts (thresholds spec §4–§5): the Overview's Active alerts with
 * Acknowledge, and the spray plan creator's badges. Figures come from the
 * server; the browser only formats them.
 */
import { call } from "./frappe";
import { formatPerHa } from "./cumulative-api";

export type AlertAction = "Alarming" | "Spray advised" | "Scout first" | "Hot spot";
export type AlertType = "House" | "Hot spot" | "Tree hot spot";
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
  /** "first beds · front" / "last rows · back"; empty for a House alert. A tree hot spot:
   *  "7 trees · rows 12–14, trees 3–9 · High, peak 9 per tree". */
  section_label?: string | null;
  measure: "Percentage" | "Count" | "Per ha";
  /** "%", "per zone", "per tree", or "/ ha this week" (block-grown crops) */
  unit: string;
  value: number | null;
  /** A hot spot's house figure, same unit as ``value`` (0 / null for a House alert). */
  house_value?: number | null;
  /** The crop's station: "zone" (rose) or "tree" (avocado). */
  station_word?: string | null;
  margin: number | null;
  reliability: "Good" | "Fair" | "Low";
  sections_scouted: number;
  sections_total: number;
  band: "Moderate" | "High";
  /** A block crop's per-hectare line this figure is judged on (per-ha alerts only). */
  threshold?: number | null;
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

/** A block-grown crop's alerts are cumulative per hectare over the ISO week. */
export const PER_HA_UNIT = "/ ha this week";
export const isPerHa = (unit?: string | null): boolean => unit === PER_HA_UNIT;

function inUnit(value: number | null | undefined, unit: string): string {
  if (value == null) return "—";
  if (unit === "%") return `${value}%`;
  return isPerHa(unit) ? `${formatPerHa(value)} ${unit}` : `${value} ${unit}`;
}

export const isTreeHotSpot = (a: { alert_type?: AlertType | null }): boolean => a.alert_type === "Tree hot spot";

/** Which of the two levels of a block crop an alert is: "Block" (the per-hectare
 *  line) or "Hot spot" (neighbouring trees over the per-tree band); null for a
 *  greenhouse crop's alert. */
export function alertLevel(a: Pick<ScoutingAlert, "unit"> & { alert_type?: AlertType | null }): "Block" | "Hot spot" | null {
  if (isTreeHotSpot(a)) return "Hot spot";
  return isPerHa(a.unit) ? "Block" : null;
}

/** "Hot spot: 7 trees in rows 12–14 over the per-tree High band". */
export function treeHotSpotLine(a: Pick<ScoutingAlert, "sections_scouted" | "section_label" | "band">): string {
  const where = (a.section_label || "").split(" · ")[1]?.split(", ")[0] ?? "";
  const n = a.sections_scouted;
  return `Hot spot: ${n} tree${n === 1 ? "" : "s"}${where ? ` in ${where}` : ""} over the per-tree ${a.band} band`;
}

/** "33.3% · ±18 · 9/9" — the figure in its unit, the margin, sections scouted.
 *  A hot spot has no margin: "80% (house 8.9%) · 5 zones in this section"
 *  ("trees" on an avocado block). */
export function alertFigureLine(
  a: Pick<ScoutingAlert, "value" | "unit" | "margin" | "sections_scouted" | "sections_total"> &
    Partial<Pick<ScoutingAlert, "alert_type" | "house_value" | "station_word" | "threshold" | "section_label" | "band">>,
): string {
  const value = inUnit(a.value, a.unit);
  if (a.alert_type === "Tree hot spot")
    return `${treeHotSpotLine({ sections_scouted: a.sections_scouted, section_label: a.section_label, band: a.band ?? "Moderate" })} · worst tree ${value}`;
  if (isPerHa(a.unit) && a.threshold) return `Block: ${value} (line ${formatPerHa(a.threshold)})`;
  // No sample margin or section count on a cumulative per-hectare figure.
  if (isPerHa(a.unit)) return `${value} · over its threshold`;
  if (a.alert_type === "Hot spot") {
    const house = a.house_value != null ? ` (house ${inUnit(a.house_value, a.unit)})` : "";
    const stations = a.station_word ? `${a.station_word}s` : "stations";
    return `${value}${house} · ${a.sections_scouted} ${stations} in this section`;
  }
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

/** The two levels' pill colours on a block crop's alert card. */
export const LEVEL_TONE = { Block: "var(--sd-data-cyan)", "Hot spot": "var(--sd-data-purple)" } as const;

/** The creator's badge for a greenhouse: its worst open spray action (D7). */
export function ghActionBadge(alerts?: CreatorAlert[] | null): "Spray advised" | "Scout first" | null {
  if (alerts?.some((a) => a.action === "Spray advised")) return "Spray advised";
  if (alerts?.some((a) => a.action === "Scout first")) return "Scout first";
  return null;
}
