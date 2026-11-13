import { useEffect, useState } from "react";
import { call } from "./frappe";

export interface PlanningWindow {
  days: number;
  today: string;
  max_date: string;
}

const FALLBACK_DAYS = 5;
let cached: Promise<PlanningWindow | null> | null = null;

/** How far ahead a plan may be dated (the server enforces it; this only guides the picker). */
export function fetchPlanningWindow(): Promise<PlanningWindow | null> {
  if (!cached) {
    cached = call<PlanningWindow>(
      "upande_scp.serverscripts.spray_plan_creator.planning_window.planning_window",
    ).catch(() => {
      cached = null;
      return null;
    });
  }
  return cached;
}

export function usePlanningWindow(): { days: number; maxDate?: string } {
  const [w, setW] = useState<PlanningWindow | null>(null);
  useEffect(() => {
    let live = true;
    void fetchPlanningWindow().then((r) => live && setW(r));
    return () => {
      live = false;
    };
  }, []);
  return w ? { days: w.days, maxDate: w.max_date } : { days: FALLBACK_DAYS };
}
