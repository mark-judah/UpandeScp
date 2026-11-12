/**
 * Dew point view: greenhouse sensor readings as 30-minute slots of temperature,
 * humidity, dew point and spread (temperature minus dew point). Backend:
 * `serverscripts.common.condensation.dew_point_series` (read-only). A spread at
 * or under the site's limit means leaves stay wet (downy mildew risk).
 */
import { call } from "./frappe";

export interface DewSlot {
  ts: string; // "YYYY-MM-DD HH:mm:ss", the slot's start, site time
  temp: number | null;
  rh: number | null;
  dew_point: number | null;
  spread: number | null;
  risk: boolean;
  sensors: number;
}

export interface DewSummary {
  min_spread: number | null;
  hours_at_risk: number;
  latest_reading: string | null;
  latest_spread: number | null;
  at_risk_now: boolean;
}

export interface DewHouse {
  greenhouse: string;
  farm: string | null;
  label: string;
  sensors: number;
  sensors_reporting: number;
  summary: DewSummary;
  slots: DewSlot[];
}

export interface DewAlert {
  name: string;
  greenhouse: string;
  farm?: string;
  alert_date: string;
  hours: number;
  min_spread: number;
  max_humidity: number;
}

export interface DewSeries {
  from: string;
  to: string;
  spread_limit: number;
  slot_minutes: number;
  sensors_available: boolean;
  mapped_sensors: number;
  greenhouses: DewHouse[];
  alerts: DewAlert[];
}

export const MAX_RANGE_DAYS = 7;

export interface DewParams {
  farms?: string;
  greenhouses?: string;
  /** both omitted: the server's last 48 hours */
  from_dt?: string;
  to_dt?: string;
}

export function fetchDewPoint(p: DewParams): Promise<DewSeries> {
  return call<DewSeries>("upande_scp.serverscripts.common.condensation.dew_point_series", {
    farms: p.farms || undefined,
    greenhouses: p.greenhouses || undefined,
    from_dt: p.from_dt,
    to_dt: p.to_dt,
  });
}

/** Slot start -> epoch ms. The server's naive site time is read as local time,
 *  which keeps the clock the greenhouse staff see. */
export const slotMs = (ts: string): number => new Date(ts.replace(" ", "T")).getTime();

export interface ChartPoint {
  t: number;
  temp: number | null;
  dew: number | null;
  spread: number | null;
}

export const chartPoints = (slots: DewSlot[]): ChartPoint[] =>
  slots.map((s) => ({ t: slotMs(s.ts), temp: s.temp, dew: s.dew_point, spread: s.spread }));

/** Consecutive at-risk slots as shaded bands `[from, to)` in epoch ms. */
export function riskBands(slots: DewSlot[], slotMinutes = 30): { x1: number; x2: number }[] {
  const step = slotMinutes * 60_000;
  const out: { x1: number; x2: number }[] = [];
  let cur: { x1: number; x2: number } | null = null;
  for (const s of slots) {
    const t = slotMs(s.ts);
    if (!s.risk) {
      cur = null;
      continue;
    }
    if (cur && t - cur.x2 <= step) cur.x2 = t + step;
    else {
      cur = { x1: t, x2: t + step };
      out.push(cur);
    }
  }
  return out;
}

export interface DewTiles {
  atRiskNow: number;
  total: number;
  hoursAtRisk: number;
  lowest: { spread: number; label: string } | null;
}

export function dewTiles(houses: DewHouse[]): DewTiles {
  let lowest: DewTiles["lowest"] = null;
  for (const h of houses) {
    const m = h.summary.min_spread;
    if (m !== null && (lowest === null || m < lowest.spread)) lowest = { spread: m, label: h.label };
  }
  return {
    atRiskNow: houses.filter((h) => h.summary.at_risk_now).length,
    total: houses.length,
    hoursAtRisk: houses.reduce((a, h) => a + h.summary.hours_at_risk, 0),
    lowest,
  };
}
