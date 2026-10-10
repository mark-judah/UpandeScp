import { call } from "./frappe";
import type { HouseFigure } from "./pest-bands";

/** Per-pest figures for one block or greenhouse — its latest scouted ISO week in
 *  the window, judged on the server like the alerts (thresholds spec D8). */
export async function fetchHouseFigures(
  crop: string,
  warehouse: string,
  from: string,
  to: string,
): Promise<Record<string, HouseFigure>> {
  try {
    const r = await call<Record<string, HouseFigure>>(
      "upande_scp.serverscripts.scouting.thresholds_check.house_figures",
      { crop, warehouse, from_date: from, to_date: to },
    );
    return r || {};
  } catch {
    return {};
  }
}
