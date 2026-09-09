/**
 * How the approvals list is arranged, and which date it is arranged by.
 *
 * Two questions get asked of this page and they are not the same one. A sprayer
 * thinks in spray dates: what is going out on Thursday. An approver clearing a
 * desk thinks in arrival: what came in today, whatever day it is for. The page
 * only ever answered the first, which is why a general manager filtering to
 * today could see an empty screen while 27 plans sat waiting — every one of them
 * written and scheduled on an earlier day.
 *
 * Grouping is the same kind of choice: a farm manager wants a farm at a time, a
 * GM signing off the morning wants one flat list. Neither is the default for
 * everyone, so both are a toggle rather than a decision made here.
 */

export type DateBasis = "scheduled" | "created";

export const DATE_BASIS_LABEL: Record<DateBasis, string> = {
  scheduled: "Spray date",
  created: "Date planned",
};

/** What the date column means, so nobody has to guess which filter is on. */
export const dateBasisHint = (basis: DateBasis): string =>
  basis === "created"
    ? "Showing plans written in this range, whatever day they are sprayed."
    : "Showing plans due to be sprayed in this range, whenever they were written.";

export interface FarmGroup<T> {
  farm: string;
  plans: T[];
}

/**
 * Group plans by farm, biggest group first.
 *
 * Plans whose farm could not be resolved are kept under "Unassigned" rather than
 * dropped — an unlinked warehouse is a data gap somebody should see, not a plan
 * that quietly disappears from an approver's queue.
 */
export const groupByFarm = <T extends { farm?: string; custom_greenhouse?: string }>(
  plans: T[],
): FarmGroup<T>[] => {
  const by = new Map<string, T[]>();
  for (const plan of plans || []) {
    const farm = (plan.farm || "").trim() || "Unassigned";
    const list = by.get(farm);
    if (list) list.push(plan);
    else by.set(farm, [plan]);
  }
  return [...by.entries()]
    .map(([farm, list]) => ({ farm, plans: list }))
    .sort((a, b) => {
      // Unassigned last: it is a gap to fix, not a farm to work through.
      if (a.farm === "Unassigned") return 1;
      if (b.farm === "Unassigned") return -1;
      if (b.plans.length !== a.plans.length) return b.plans.length - a.plans.length;
      return a.farm.localeCompare(b.farm);
    });
};
