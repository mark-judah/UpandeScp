/**
 * Whitelisted endpoints for the Spray Plan Access admin page.
 *
 * Backend module: upande_scp.serverscripts.spray_plan_creator.admin
 * Permission: General Manager / System Manager only.
 *
 * NOTE: call() in ./frappe already unwraps the Frappe { message: T }
 * envelope — we pass T directly as the type parameter.
 */

import { call } from "./frappe";

export interface FarmCreatorRow {
  user: string;
  full_name: string;
}

/** Same shape as a creator row — kept as a distinct type for callsite
 *  clarity. Creators and approvers are independent rosters. */
export type FarmApproverRow = FarmCreatorRow;

export interface FarmWithCreators {
  farm: string;
  farm_name: string | null;
  business_unit: string;
  creators: FarmCreatorRow[];
  approvers: FarmApproverRow[];
}

export interface CreatorCandidate {
  user: string;
  full_name: string | null;
  email: string | null;
}

const PREFIX = "upande_scp.serverscripts.spray_plan_creator.admin";

export async function listFarmsWithCreators(): Promise<FarmWithCreators[]> {
  const r = await call<FarmWithCreators[]>(`${PREFIX}.list_farms_with_creators`);
  // Older server builds don't include ``approvers`` yet — normalise to
  // [] so consumers can always assume the field is present.
  return (r ?? []).map((row) => ({
    ...row,
    approvers: row.approvers ?? [],
  }));
}

export async function listCreatorCandidates(q?: string): Promise<CreatorCandidate[]> {
  const r = await call<CreatorCandidate[]>(
    `${PREFIX}.list_spray_plan_creator_candidates`,
    { q: q ?? "" },
  );
  return r ?? [];
}

export async function listApproverCandidates(q?: string): Promise<CreatorCandidate[]> {
  const r = await call<CreatorCandidate[]>(
    `${PREFIX}.list_spray_plan_approver_candidates`,
    { q: q ?? "" },
  );
  return r ?? [];
}

export async function setFarmCreators(
  farm: string,
  users: string[],
): Promise<{ farm: string; creators: FarmCreatorRow[] }> {
  return call<{ farm: string; creators: FarmCreatorRow[] }>(
    `${PREFIX}.set_farm_creators`,
    { farm, users: JSON.stringify(users) },
  );
}

export async function setFarmApprovers(
  farm: string,
  users: string[],
): Promise<{ farm: string; approvers: FarmApproverRow[] }> {
  return call<{ farm: string; approvers: FarmApproverRow[] }>(
    `${PREFIX}.set_farm_approvers`,
    { farm, users: JSON.stringify(users) },
  );
}
