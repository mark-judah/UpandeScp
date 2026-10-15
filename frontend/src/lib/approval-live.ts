/**
 * Live Spray Plan Approvals, the pure part: which realtime events matter to the
 * page, and how a fresh feed merges into what the approver is looking at.
 *
 * The server publishes `scp:spray_plan` (see serverscripts/spray_plan_ops/
 * approval_realtime.py) when a plan is created, submitted or moves workflow
 * state. An event is only a nudge: the page re-reads the list and `mergeFeed`
 * works out what is new, so a missed or duplicated event can never corrupt the
 * list, and the user's selection and expansion are never touched.
 */

import type { PendingWorkOrder } from "@/lib/spray-plan-api";

export const SPRAY_PLAN_EVENT = "scp:spray_plan";
/** Poll period while the socket is down. */
export const POLL_MS = 30_000;

export interface SprayPlanEvent {
  change: "created" | "submitted" | "state_changed";
  name: string;
  workflow_state: string;
  /** Spray date (scheduled application, else planned start), YYYY-MM-DD. */
  date: string;
  /** Creation date, YYYY-MM-DD. */
  created: string;
  farm: string;
  greenhouse: string;
}

export interface LiveScope {
  from: string;
  to: string;
  dateBasis: "scheduled" | "created";
  /** "" = all */
  farm: string;
  greenhouse: string;
}

/** Does this event concern what the page is showing (date range + place)? */
export function eventMatches(ev: Partial<SprayPlanEvent> | null | undefined, scope: LiveScope): boolean {
  if (!ev || !ev.name) return false;
  const day = scope.dateBasis === "created" ? ev.created : ev.date;
  if (day) {
    if (scope.from && day < scope.from) return false;
    if (scope.to && day > scope.to) return false;
  }
  if (scope.greenhouse && ev.greenhouse && ev.greenhouse !== scope.greenhouse) return false;
  if (!scope.greenhouse && scope.farm && ev.farm && ev.farm !== scope.farm) return false;
  return true;
}

export interface FeedState {
  wos: PendingWorkOrder[];
  /** Plans that arrived while the page was open and have not been looked at. */
  fresh: Set<string>;
}

export const EMPTY_FEED: FeedState = { wos: [], fresh: new Set() };

/**
 * Merge a freshly fetched list into the page state.
 *
 * * the server's list is the truth for membership and order, and is deduped by
 *   name (a plan fetched twice, or announced twice, shows once);
 * * a plan not in `prev` is "new" only when `announce` (a live refresh, not the
 *   first load or a filter change) — it joins `fresh` and is returned in `added`;
 * * `fresh` forgets plans that left the list, so it never grows without bound.
 */
export function mergeFeed(
  prev: FeedState,
  incoming: PendingWorkOrder[],
  announce: boolean,
): { state: FeedState; added: PendingWorkOrder[] } {
  const seen = new Set<string>();
  const wos: PendingWorkOrder[] = [];
  for (const w of incoming) {
    if (seen.has(w.name)) continue;
    seen.add(w.name);
    wos.push(w);
  }
  const known = new Set(prev.wos.map((w) => w.name));
  const added = announce ? wos.filter((w) => !known.has(w.name)) : [];
  const fresh = new Set<string>();
  prev.fresh.forEach((n) => seen.has(n) && fresh.add(n));
  added.forEach((w) => fresh.add(w.name));
  return { state: { wos, fresh }, added };
}

/** A selection that survives a refresh: only plans no longer listed drop out. */
export function keepSelection(selected: Set<string>, wos: PendingWorkOrder[]): Set<string> {
  const names = new Set(wos.map((w) => w.name));
  const next = new Set<string>();
  selected.forEach((n) => names.has(n) && next.add(n));
  return next.size === selected.size ? selected : next;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-15" -> "15 Oct" */
export function shortDay(ymdStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymdStr || "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : ymdStr || "";
}

/** "2 new plans for 15 Oct" — the day when they share one, else the range. */
export function newPlansMessage(count: number, days: string[], fallback = "the selected dates"): string {
  const uniq = Array.from(new Set(days.filter(Boolean)));
  const where = uniq.length === 1 ? shortDay(uniq[0]) : fallback;
  return `${count} new plan${count === 1 ? "" : "s"} for ${where}`;
}
