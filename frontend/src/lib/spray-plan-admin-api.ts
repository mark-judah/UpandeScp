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

export interface FarmWithCreators {
  farm: string;
  farm_name: string | null;
  business_unit: string;
  creators: FarmCreatorRow[];
}

export interface CreatorCandidate {
  user: string;
  full_name: string | null;
  email: string | null;
}

const PREFIX = "upande_scp.serverscripts.spray_plan_creator.admin";

export async function listFarmsWithCreators(): Promise<FarmWithCreators[]> {
  const r = await call<FarmWithCreators[]>(`${PREFIX}.list_farms_with_creators`);
  return r ?? [];
}

export async function listCreatorCandidates(q?: string): Promise<CreatorCandidate[]> {
  const r = await call<CreatorCandidate[]>(
    `${PREFIX}.list_spray_plan_creator_candidates`,
    { q: q ?? "" },
  );
  return r ?? [];
}

export async function setFarmCreators(
  farm: string,
  users: string[],
): Promise<FarmWithCreators> {
  const r = await call<{ farm: string; creators: FarmCreatorRow[] }>(
    `${PREFIX}.set_farm_creators`,
    { farm, users: JSON.stringify(users) },
  );
  return {
    farm: r.farm,
    farm_name: null,
    business_unit: "",
    creators: r.creators,
  };
}
