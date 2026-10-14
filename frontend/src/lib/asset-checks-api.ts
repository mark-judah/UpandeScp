import { call } from "./frappe";

const NS = "upande_scp.serverscripts.asset_checks.api";

export interface AssetCheckRow {
  farm: string;
  asset_category: string;
  enabled: number;
}

export interface AssetCheckSettings {
  /** false when the Upande Asset app is not installed on this site */
  installed: boolean;
  enabled: number;
  rows: AssetCheckRow[];
  farms: string[];
  /** asset categories that have at least one check sheet template */
  categories: string[];
}

export function fetchAssetCheckSettings(): Promise<AssetCheckSettings> {
  return call<AssetCheckSettings>(`${NS}.get_asset_check_settings`);
}

export function saveAssetCheckSettings(payload: {
  enabled: number;
  rows: AssetCheckRow[];
}): Promise<AssetCheckSettings> {
  return call<AssetCheckSettings>(`${NS}.save_asset_check_settings`, {
    payload: JSON.stringify(payload),
  });
}
