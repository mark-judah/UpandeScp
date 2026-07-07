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

/** Same shape as a creator row — the Store Keeper roster is independent
 *  of Creators/Approvers. */
export type FarmStoreKeeperRow = FarmCreatorRow;

export interface FarmWithCreators {
  farm: string;
  farm_name: string | null;
  business_unit: string;
  creators: FarmCreatorRow[];
  approvers: FarmApproverRow[];
  store_keepers: FarmStoreKeeperRow[];
  chemical_store: string | null;
  fertilizer_store: string | null;
}

export interface StoreWarehouseCandidate {
  name: string;
  custom_farm: string | null;
}

export interface CreatorCandidate {
  user: string;
  full_name: string | null;
  email: string | null;
}

const PREFIX = "upande_scp.serverscripts.spray_plan_creator.admin";

export async function listFarmsWithCreators(): Promise<FarmWithCreators[]> {
  const r = await call<FarmWithCreators[]>(`${PREFIX}.list_farms_with_creators`);
  // Older server builds don't include ``approvers``/``store_keepers`` (or
  // the store fields) yet — normalise so consumers can always assume the
  // fields are present.
  return (r ?? []).map((row) => ({
    ...row,
    approvers: row.approvers ?? [],
    store_keepers: row.store_keepers ?? [],
    chemical_store: row.chemical_store ?? null,
    fertilizer_store: row.fertilizer_store ?? null,
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

export async function listStoreKeeperCandidates(q?: string): Promise<CreatorCandidate[]> {
  const r = await call<CreatorCandidate[]>(
    `${PREFIX}.list_store_keeper_candidates`,
    { q: q ?? "" },
  );
  return r ?? [];
}

export async function listStoreWarehouseCandidates(
  q?: string,
): Promise<StoreWarehouseCandidate[]> {
  const r = await call<StoreWarehouseCandidate[]>(
    `${PREFIX}.list_store_warehouse_candidates`,
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

/** NOTE: unlike set_farm_approvers, the backend `set_farm_store_keepers`
 *  does not remap its roster onto a `store_keepers` key — it returns the
 *  raw `_set_farm_roster` shape (`{farm, roster, creators}`, with
 *  `creators` always `[]` for this child table). We re-key `roster` onto
 *  `store_keepers` here so callers get the same shape as the other two
 *  roster setters. */
export async function setFarmStoreKeepers(
  farm: string,
  users: string[],
): Promise<{ farm: string; store_keepers: FarmStoreKeeperRow[] }> {
  const r = await call<{ farm: string; roster: FarmStoreKeeperRow[] }>(
    `${PREFIX}.set_farm_store_keepers`,
    { farm, users: JSON.stringify(users) },
  );
  return { farm: r.farm, store_keepers: r.roster ?? [] };
}

export async function setFarmStores(
  farm: string,
  chemical_store: string | null,
  fertilizer_store: string | null,
): Promise<{ farm: string; chemical_store: string | null; fertilizer_store: string | null }> {
  return call<{ farm: string; chemical_store: string | null; fertilizer_store: string | null }>(
    `${PREFIX}.set_farm_stores`,
    { farm, chemical_store, fertilizer_store },
  );
}
