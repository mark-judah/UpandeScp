import { call } from "./frappe";
import { getPayload, setPayload } from "./idb";
import type {
  RawEntry,
  ScoutingEntry,
  PestObs,
  DiseaseObs,
  TrapObs,
  ProcessedData,
  ChunkResponse,
  ScoutingMeta,
} from "./scouting-types";

export const DEFAULT_CROP = "Rose";

const toNumber = (v: any): number => {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
};

export function normalizeScoutingEntries(raw: RawEntry[]): ScoutingEntry[] {
  const byName: Record<string, ScoutingEntry> = {};
  const unnamed: RawEntry[] = [];

  const ensureEntry = (row: RawEntry): ScoutingEntry | null => {
    const key = row?.name ? String(row.name) : "";
    if (!key) return null;
    if (!byName[key]) {
      byName[key] = {
        name: key,
        date_of_capture: row?.date_of_capture || "",
        time_of_capture: row?.time_of_capture || "",
        greenhouse: row?.greenhouse || "",
        bed: row?.bed || "",
        zone: row?.zone || "",
        block: row?.block || "",
        row: row?.row || "",
        tree: row?.tree || "",
        crop_scouted: row?.crop_scouted || "",
        owner: row?.owner || "",
        modified_by: row?.modified_by || "",
        scouts_name: row?.scouts_name || row?.scout_name || row?.scout || "",
        latitude: row?.latitude,
        longitude: row?.longitude,
        pests_scouting_entry: [],
        diseases_scouting_entry: [],
        trap_scouting_entry: [],
      };
    } else {
      const ex = byName[key];
      const fill = (k: keyof ScoutingEntry, v: any) => {
        if (!ex[k] && v) (ex as any)[k] = v;
      };
      fill("date_of_capture", row?.date_of_capture);
      fill("time_of_capture", row?.time_of_capture);
      fill("greenhouse", row?.greenhouse);
      fill("bed", row?.bed);
      fill("zone", row?.zone);
      fill("block", row?.block);
      fill("row", row?.row);
      fill("tree", row?.tree);
      fill("crop_scouted", row?.crop_scouted);
      fill("owner", row?.owner);
      fill("modified_by", row?.modified_by);
      fill(
        "scouts_name",
        row?.scouts_name || row?.scout_name || row?.scout || "",
      );
      fill("latitude", row?.latitude);
      fill("longitude", row?.longitude);
    }
    return byName[key];
  };

  const hasAnyObs = (row: RawEntry): boolean => {
    const keys = [
      "pests_scouting_entry",
      "pests",
      "diseases_scouting_entry",
      "diseases",
      "trap_scouting_entry",
      "traps",
    ];
    return keys.some((k) => Array.isArray(row[k]) && row[k].length > 0);
  };

  const append = (target: ScoutingEntry, row: RawEntry) => {
    const pests: any[] = Array.isArray(row.pests_scouting_entry)
      ? row.pests_scouting_entry
      : Array.isArray(row.pests)
        ? row.pests
        : [];
    const diseases: any[] = Array.isArray(row.diseases_scouting_entry)
      ? row.diseases_scouting_entry
      : Array.isArray(row.diseases)
        ? row.diseases
        : [];
    const traps: any[] = Array.isArray(row.trap_scouting_entry)
      ? row.trap_scouting_entry
      : Array.isArray(row.traps)
        ? row.traps
        : [];

    pests.forEach((p) => {
      if (!p || !(p.pest || p.pest_name)) return;
      target.pests_scouting_entry.push({
        pest: p.pest || p.pest_name,
        plant_section: p.plant_section || p.section || p.pest_plant_section,
        stage: p.stage || p.pest_stage || "",
        count: toNumber(p.count ?? p.pest_count ?? 1),
      } as PestObs);
    });
    diseases.forEach((d) => {
      if (!d || !(d.disease || d.disease_name)) return;
      target.diseases_scouting_entry.push({
        disease: d.disease || d.disease_name,
        plant_section:
          d.plant_section || d.section || d.disease_plant_section,
        stage: d.stage || d.severity_level || d.disease_stage || "",
        severity_level: d.severity_level || d.stage || "",
      } as DiseaseObs);
    });
    traps.forEach((t) => {
      if (!t || !(t.trap || t.trap_name)) return;
      target.trap_scouting_entry.push({
        trap: t.trap || t.trap_name,
        pest: t.pest || t.trap_pest,
        location: t.location || t.plant_section || t.trap_location,
        count: toNumber(t.count ?? t.trap_count ?? 0),
      } as TrapObs);
    });

    const flatPest = row.pest_pest || row.pest;
    if (flatPest) {
      target.pests_scouting_entry.push({
        pest: flatPest,
        plant_section:
          row.pest_plant_section || row.plant_section || "",
        stage: row.pest_stage || row.stage || "",
        count: toNumber(row.pest_count ?? row.count ?? 1),
      });
    }
    const flatDisease = row.disease_disease || row.disease;
    if (flatDisease) {
      target.diseases_scouting_entry.push({
        disease: flatDisease,
        plant_section: row.disease_plant_section || row.plant_section || "",
        stage: row.disease_stage || row.stage || row.severity_level || "",
        severity_level:
          row.disease_stage || row.severity_level || row.stage || "",
      });
    }
    const flatTrap = row.trap_trap || row.trap || row.trap_name;
    if (flatTrap) {
      target.trap_scouting_entry.push({
        trap: flatTrap,
        pest: row.trap_pest || row.pest || "",
        location: row.trap_location || row.location || row.plant_section || "",
        count: toNumber(row.trap_count ?? row.count ?? 0),
      });
    }
  };

  raw.forEach((row) => {
    const target = ensureEntry(row);
    if (!target) {
      unnamed.push(row);
      return;
    }
    append(target, row);
    if (hasAnyObs(row)) target._hasAnyObs = true;
  });

  return Object.values(byName)
    .filter((e) => e._hasAnyObs)
    .sort((a, b) => {
      if (a.date_of_capture !== b.date_of_capture)
        return b.date_of_capture.localeCompare(a.date_of_capture);
      return (b.time_of_capture || "").localeCompare(a.time_of_capture || "");
    });
}

export function getEntryWarehouse(entry: ScoutingEntry): string {
  return entry.greenhouse || entry.block || "Unknown";
}

export function getScoutIdentity(entry: ScoutingEntry): {
  key: string;
  label: string;
} {
  const candidates = [
    entry.scouts_name,
    entry.modified_by,
    entry.owner,
  ].filter(Boolean);
  const labelFromEmail = (s: string) => {
    if (!s.includes("@")) return s;
    const prefix = s.split("@")[0];
    return prefix
      .split(/[._-]/g)
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  };
  const raw = candidates[0] || "";
  return { key: raw, label: labelFromEmail(raw) };
}

const sevByMagnitude = (count: number): "low" | "moderate" | "high" => {
  if (count > 15) return "high";
  if (count > 5) return "moderate";
  return "low";
};

const sevByDiseaseKeyword = (
  s: string,
): "low" | "moderate" | "high" => {
  const t = (s || "").toLowerCase();
  if (t.includes("high") || t.includes("severe") || t.includes("active"))
    return "high";
  if (t.includes("moderate") || t.includes("medium")) return "moderate";
  return "low";
};

export function buildScoutingData(rawEntries: RawEntry[]): ProcessedData {
  const entries = normalizeScoutingEntries(rawEntries);
  const data: ProcessedData = {
    entries,
    pests: {},
    diseases: {},
    traps: {},
    greenhouses: {},
    scouts: {},
    daily: {},
  };

  entries.forEach((entry) => {
    const date = entry.date_of_capture;
    const wh = getEntryWarehouse(entry);
    const { key: scoutKey, label: scoutLabel } = getScoutIdentity(entry);

    if (!data.daily[date])
      data.daily[date] = { pests: 0, diseases: 0, traps: 0, total: 0 };
    data.daily[date].total++;
    if (!data.greenhouses[wh])
      data.greenhouses[wh] = {
        name: wh,
        pests: 0,
        diseases: 0,
        traps: 0,
        scouts: new Set(),
        alerts: 0,
      };

    const locMeta = {
      greenhouse: entry.greenhouse,
      bed: entry.bed,
      zone: entry.zone,
      block: entry.block,
      row: entry.row,
      tree: entry.tree,
    };

    entry.pests_scouting_entry.forEach((p) => {
      const name = p.pest || "Unknown";
      const stage = p.stage || "Unknown";
      if (!data.pests[name])
        data.pests[name] = {
          name,
          counts: [],
          stages: {},
          sections: {},
          severity: { low: 0, moderate: 0, high: 0 },
        };
      const count = toNumber(p.count || 1);
      data.pests[name].counts.push({
        ...p,
        date,
        count,
        stage,
        section: p.plant_section,
        ...locMeta,
      } as any);
      data.pests[name].stages[stage] =
        (data.pests[name].stages[stage] || 0) + count;
      if (p.plant_section)
        data.pests[name].sections[p.plant_section] =
          (data.pests[name].sections[p.plant_section] || 0) + count;
      data.pests[name].severity[sevByMagnitude(count)]++;
      data.daily[date].pests++;
      data.greenhouses[wh].pests++;
    });

    entry.diseases_scouting_entry.forEach((d) => {
      const name = d.disease || "Unknown";
      const stage = d.stage || d.severity_level || "";
      if (!data.diseases[name])
        data.diseases[name] = {
          name,
          counts: [],
          stages: {},
          severity: { low: 0, moderate: 0, high: 0 },
        };
      data.diseases[name].counts.push({
        date,
        stage,
        section: d.plant_section,
        ...locMeta,
      });
      if (stage)
        data.diseases[name].stages[stage] =
          (data.diseases[name].stages[stage] || 0) + 1;
      data.diseases[name].severity[
        sevByDiseaseKeyword(d.severity_level || d.stage || "")
      ]++;
      data.daily[date].diseases++;
      data.greenhouses[wh].diseases++;
    });

    entry.trap_scouting_entry.forEach((t) => {
      const trapId = t.trap || "Unknown";
      const pest = t.pest || "Unknown";
      const key = `${trapId}-${pest}`;
      const loc = t.location;
      const count = toNumber(t.count || 0);
      if (!data.traps[key])
        data.traps[key] = {
          trap: trapId,
          pest,
          location: loc,
          counts: [],
          total: 0,
        };
      data.traps[key].counts.push({
        date,
        count,
        location: loc,
        greenhouse: wh,
      });
      data.traps[key].total += count;
      if (count > 10) data.greenhouses[wh].alerts++;
      data.daily[date].traps++;
      data.greenhouses[wh].traps++;
    });

    if (scoutKey) {
      data.greenhouses[wh].scouts.add(scoutKey);
      if (!data.scouts[scoutKey])
        data.scouts[scoutKey] = { entries: 0, name: scoutLabel || scoutKey };
      data.scouts[scoutKey].entries++;
    }
  });

  Object.values(data.greenhouses).forEach((g) => {
    g.scoutCount = g.scouts.size;
  });

  return data;
}

/* ---------- API helpers ---------- */

export async function fetchChunk(
  fromDate: string,
  toDate: string,
  greenhouse?: string,
): Promise<ChunkResponse> {
  const r = await call<ChunkResponse>(
    "upande_scp.serverscripts.get_complete_scouting_entries.getScoutingEntriesChunk",
    {
      from_date: fromDate,
      to_date: toDate,
      greenhouse: greenhouse || undefined,
      include_meta: 1,
    },
  );
  return (r || {}) as ChunkResponse;
}

export async function fetchFarmsAndWarehouses(): Promise<
  Record<string, string[]>
> {
  try {
    const r = await call<Record<string, string[]>>(
      "upande_scp.serverscripts.scouting_metrics_api.get_farms_and_warehouses",
      {},
    );
    return r || {};
  } catch {
    return {};
  }
}

export async function fetchCrops(): Promise<
  Array<{ name: string; crop_name: string; farms?: string[] }>
> {
  try {
    const r = await call<
      Array<{ name: string; crop_name: string; farms?: string[] }>
    >("upande_scp.serverscripts.scouting_metrics_api.get_crops_with_farms", {});
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Reference data — long-lived, change rarely. Kept in module scope so */
/* repeated hook calls don't re-hit the network within a session.     */
/* ------------------------------------------------------------------ */

const REFERENCE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CacheEntry<T> {
  ts: number;
  value: T;
}

const refCache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = refCache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < REFERENCE_TTL_MS) return hit.value;
  const value = await loader();
  refCache.set(key, { ts: Date.now(), value });
  return value;
}

export interface BedZoneNode {
  name: string;
  zones: Array<{ name: string; raw_geojson?: string }>;
}

export interface VarietyNode {
  variety: string;
  beds: BedZoneNode[];
}

/**
 * Bed × Zone tree — the geometry denominator for every heatmap/floor-plan
 * page. Multi-tier cache so re-renders, page switches, and full-page
 * reloads all stay snappy:
 *
 *   - module-level in-memory map (instant after first call this session)
 *   - IndexedDB payload (survives reloads; 24h freshness window)
 *   - server endpoint (last resort; the server itself caches this for 24h)
 *
 * Bumping ``BEDS_ZONES_VERSION`` discards every cached row — use this if
 * the payload shape changes server-side (e.g. a new field operators rely
 * on for filters).
 */
const BEDS_ZONES_VERSION = 1;
const BEDS_ZONES_KEY = "beds_zones_v1";
const BEDS_ZONES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function fetchBedsAndZones(): Promise<VarietyNode[]> {
  return cached("beds_zones", async () => {
    // 1. IDB hit — almost instant, no network.
    try {
      const idbHit = await getPayload<VarietyNode[]>(
        BEDS_ZONES_KEY,
        BEDS_ZONES_VERSION,
        BEDS_ZONES_MAX_AGE_MS,
      );
      if (idbHit && idbHit.length) {
        // Schedule a stale-while-revalidate pass: refresh in the background
        // so subsequent visits get newer geometry without blocking this one.
        void refreshBedsAndZonesInBackground();
        return idbHit;
      }
    } catch {
      // IDB might be unavailable in private browsing; fall through.
    }

    // 2. Network — first hit of the session, or IDB stale/missing.
    const fresh = await fetchBedsAndZonesFromServer();
    if (fresh.length) {
      try {
        await setPayload(BEDS_ZONES_KEY, fresh, BEDS_ZONES_VERSION);
      } catch {
        /* IDB write failures are non-fatal */
      }
    }
    return fresh;
  });
}

async function fetchBedsAndZonesFromServer(): Promise<VarietyNode[]> {
  try {
    const r = await call<{ data: VarietyNode[] } | VarietyNode[]>(
      "upande_scp.serverscripts.get_beds_and_zones.getBedsAndZones",
      {},
    );
    if (Array.isArray(r)) return r;
    const wrapped = r as { data?: VarietyNode[] };
    return wrapped?.data || [];
  } catch {
    return [];
  }
}

let bgRefreshInFlight = false;
async function refreshBedsAndZonesInBackground(): Promise<void> {
  if (bgRefreshInFlight) return;
  bgRefreshInFlight = true;
  try {
    const fresh = await fetchBedsAndZonesFromServer();
    if (fresh.length) {
      await setPayload(BEDS_ZONES_KEY, fresh, BEDS_ZONES_VERSION);
      // Update the in-memory cache so the next call sees the new value.
      refCache.set("beds_zones", { ts: Date.now(), value: fresh });
    }
  } catch {
    /* swallow — the page already has the previous payload */
  } finally {
    bgRefreshInFlight = false;
  }
}

/**
 * Prime the bed/zone cache before any consumer asks. Call this on app
 * mount so switching to Heatmaps / Application Plan / Varieties is
 * instant — the IDB read happens in parallel with the rest of the boot.
 */
export function primeBedsAndZones(): void {
  void fetchBedsAndZones().catch(() => {});
}

/**
 * Reverse map of greenhouse → farm. Derived from
 * scouting_metrics_api.get_farms_and_warehouses (already cached server-side).
 */
export async function fetchGreenhouseToFarm(): Promise<Record<string, string>> {
  return cached("gh_to_farm", async () => {
    const farms = await fetchFarmsAndWarehouses();
    const out: Record<string, string> = {};
    Object.entries(farms).forEach(([farm, ghs]) => {
      (ghs || []).forEach((g) => {
        out[g] = farm;
      });
    });
    return out;
  });
}

/**
 * Per-greenhouse zone count (denominator for "% zones with observation"
 * computations). Comes from the same payload meta endpoint but exposed
 * standalone here so non-scouting pages don't have to fetch the entries.
 */
export async function fetchZonesByGreenhouse(): Promise<
  Record<string, number>
> {
  return cached("zones_by_gh", async () => {
    try {
      const r = await call<Record<string, number>>(
        "upande_scp.serverscripts.scouting_metrics_api.get_zone_counts_by_greenhouse",
        {},
      );
      return r || {};
    } catch {
      return {};
    }
  });
}

/**
 * Map of scout employee ID → readable name. Used by Top Scouts widgets to
 * replace the raw ``"200397"`` IDs with the actual employee name.
 */
export async function fetchScoutLookup(): Promise<Record<string, string>> {
  return cached("scout_lookup", async () => {
    try {
      const r = await call<Record<string, string>>(
        "upande_scp.serverscripts.scouting_metrics_api.get_scout_lookup",
        {},
      );
      return r || {};
    } catch {
      return {};
    }
  });
}

/* ------------------------------------------------------------------ */
/* Geometry helpers — used by the map-based pages.                    */
/* ------------------------------------------------------------------ */

export interface GeoJsonFC {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: any;
    properties: Record<string, unknown>;
  }>;
}

/**
 * Orchard trees as a GeoJSON FeatureCollection. Used by the Avocado map.
 * The endpoint already caches per-block + per-farm server-side.
 */
export async function fetchOrchardTreesGeojson(
  args: { block?: string; farm?: string } = {},
): Promise<GeoJsonFC> {
  const key = `orchard:${args.block || ""}:${args.farm || ""}`;
  return cached(key, async () => {
    try {
      const r = await call<GeoJsonFC>(
        "upande_scp.serverscripts.get_orchard_trees.get_orchard_trees_geojson",
        args,
      );
      return r || { type: "FeatureCollection", features: [] };
    } catch {
      return { type: "FeatureCollection", features: [] };
    }
  });
}

export interface PlanBootstrap {
  warehouses: Array<{ name: string; custom_farm?: string }>;
  kits: Array<{ kit: string; warehouse?: string }>;
  boms: Array<{
    name: string;
    item_name?: string;
    custom_farm?: string;
    uom?: string;
    quantity?: number;
  }>;
  /** Names of enabled Spray Team rows — drives the ``custom_spray_team``
   *  dropdown on the application plan page. Defaults to ``[]`` for
   *  older bootstrap responses that pre-date the field. */
  spray_teams?: string[];
}

export interface BomChemical {
  item_code: string;
  item_name?: string;
  stock_qty?: number;
  stock_uom?: string;
  rate?: number;
  amount?: number;
  idx?: number;
  item_group?: string;
  /** Set by get_bom_details — used to pick the right warehouse list. */
  is_fertilizer?: boolean;
  balances?: Record<string, number>;
}

export interface ChemicalItem {
  item_code: string;
  item_name?: string;
  stock_uom?: string;
  item_group?: string;
  is_fertilizer?: boolean;
}

export async function searchChemicalItems(
  q?: string,
): Promise<ChemicalItem[]> {
  try {
    return await call<ChemicalItem[]>(
      "upande_scp.serverscripts.scouting_metrics_api.list_chemical_items",
      { q: q || undefined, limit: 50 },
    );
  } catch {
    return [];
  }
}

export interface BomDetails {
  name: string;
  item_name?: string;
  uom?: string;
  quantity?: number;
  custom_water_ph?: number;
  custom_water_hardness?: number;
  custom_water_volume?: number;
  custom_farm?: string;
  custom_business_unit?: string;
  chemicals: BomChemical[];
  chemical_warehouses: string[];
  fertilizer_warehouses: string[];
}

export async function fetchBomDetails(
  name: string,
): Promise<BomDetails | null> {
  if (!name) return null;
  return cached(`bom:${name}`, async () => {
    try {
      return await call<BomDetails>(
        "upande_scp.serverscripts.scouting_metrics_api.get_bom_details",
        { name },
      );
    } catch {
      return null as unknown as BomDetails;
    }
  });
}

export async function fetchApplicationPlanBootstrap(): Promise<PlanBootstrap> {
  return cached("plan_bootstrap", async () => {
    try {
      const r = await call<PlanBootstrap>(
        "upande_scp.serverscripts.scouting_metrics_api.get_application_plan_bootstrap",
        {},
      );
      return r || { warehouses: [], kits: [], boms: [], spray_teams: [] };
    } catch {
      return { warehouses: [], kits: [], boms: [], spray_teams: [] };
    }
  });
}

/** Per-bed area data — one row per Bed doctype record, used by the
 *  ApplicationPlan page to compute the area-to-spray (and water volume)
 *  reactively from the picked scope. Mirrors the legacy
 *  ``state.bedData`` shape from ``new_application_floor_plan.js``. */
export interface BedAreaRow {
  /** Doctype primary key — looks like "Greenhouse X - Bed 12". */
  name: string;
  /** Just the trailing bed identifier (e.g. "12"). */
  bed: string;
  unit_type?: string;
  variety?: string;
  /** Square metres — divide by 10000 for hectares. */
  bed__area?: number;
}

/** Cached fetch of every active bed grouped by greenhouse. Server-side
 *  the response is cached for hours, so the network cost is paid at
 *  most once per session. */
export async function fetchBedsByGreenhouse(): Promise<
  Record<string, BedAreaRow[]>
> {
  return cached("beds_by_gh", async () => {
    try {
      const r = await call<Record<string, BedAreaRow[]>>(
        "upande_scp.serverscripts.scouting_metrics_api.get_beds_by_greenhouse",
        { active_only: 1 },
      );
      return r || {};
    } catch {
      return {};
    }
  });
}

/** Create a new Chemical Mix BOM. Mirrors the legacy
 *  `create_application_floor_plan` page's BOM creation modal — used by
 *  ApplicationPlan when the operator can't find the BOM they want in
 *  the dropdown and wants to define one inline. */
export interface CreateBomArgs {
  item: string;
  custom_water_ph: number;
  custom_water_hardness: number;
  items: Array<{
    item_code: string;
    item_name?: string;
    qty: number;
    stock_uom?: string;
    rate?: number;
  }>;
  custom_greenhouse?: string;
  custom_farm?: string;
}

export interface CreateBomResult {
  status: "success" | "error";
  message?: string;
  bom_name?: string;
}

export async function createBom(args: CreateBomArgs): Promise<CreateBomResult> {
  try {
    const r = await call<CreateBomResult>(
      "upande_scp.serverscripts.create_bom.createBOM",
      args as unknown as Record<string, unknown>,
    );
    return r || { status: "error", message: "No response from server" };
  } catch (e: any) {
    return { status: "error", message: e?.message || "Failed to create BOM" };
  }
}

export async function fetchBlocksGeojson(): Promise<GeoJsonFC> {
  return cached("blocks_geojson", async () => {
    try {
      const r = await call<GeoJsonFC>(
        "upande_scp.serverscripts.scouting_metrics_api.get_blocks_geojson",
        {},
      );
      return r || { type: "FeatureCollection", features: [] };
    } catch {
      return { type: "FeatureCollection", features: [] };
    }
  });
}

/**
 * Map Settings — global default lat/lon/zoom + per-farm overrides used by
 * the Traps / Observations / Rose Scouting maps to fly-to a farm when the
 * operator selects one. IDB-cached on top of the server's cache so a
 * full-page reload doesn't have to round-trip again.
 */
export interface FarmCoord {
  lat: number;
  lon: number;
  zoom: number;
}
export interface MapSettings {
  lat: number;
  lon: number;
  default_zoom: number;
  farms: Record<string, FarmCoord>;
}

const MAP_SETTINGS_VERSION = 1;
const MAP_SETTINGS_KEY = "map_settings_v1";
const MAP_SETTINGS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EMPTY_MAP_SETTINGS: MapSettings = {
  lat: 0,
  lon: 0,
  default_zoom: 16,
  farms: {},
};

export async function fetchMapSettings(): Promise<MapSettings> {
  return cached("map_settings", async () => {
    try {
      const idbHit = await getPayload<MapSettings>(
        MAP_SETTINGS_KEY,
        MAP_SETTINGS_VERSION,
        MAP_SETTINGS_MAX_AGE_MS,
      );
      if (idbHit) {
        // Refresh in the background so an admin's edit in the doctype
        // appears on the next render without blocking this one.
        void refreshMapSettingsInBackground();
        return idbHit;
      }
    } catch {
      /* IDB might be unavailable in private browsing */
    }
    const fresh = await fetchMapSettingsFromServer();
    try {
      await setPayload(MAP_SETTINGS_KEY, fresh, MAP_SETTINGS_VERSION);
    } catch {
      /* non-fatal */
    }
    return fresh;
  });
}

async function fetchMapSettingsFromServer(): Promise<MapSettings> {
  try {
    const r = await call<MapSettings>(
      "upande_scp.serverscripts.scouting_metrics_api.get_map_settings",
      {},
    );
    if (!r) return EMPTY_MAP_SETTINGS;
    return {
      lat: Number(r.lat) || 0,
      lon: Number(r.lon) || 0,
      default_zoom: Number(r.default_zoom) || 16,
      farms: r.farms || {},
    };
  } catch {
    return EMPTY_MAP_SETTINGS;
  }
}

let mapSettingsBgInFlight = false;
async function refreshMapSettingsInBackground(): Promise<void> {
  if (mapSettingsBgInFlight) return;
  mapSettingsBgInFlight = true;
  try {
    const fresh = await fetchMapSettingsFromServer();
    await setPayload(MAP_SETTINGS_KEY, fresh, MAP_SETTINGS_VERSION);
    refCache.set("map_settings", { ts: Date.now(), value: fresh });
  } catch {
    /* swallow — page already rendered with the previous payload */
  } finally {
    mapSettingsBgInFlight = false;
  }
}

/** Prime the Map Settings cache on app boot — same idiom as
 *  ``primeBedsAndZones`` so picking a farm is instant. */
export function primeMapSettings(): void {
  void fetchMapSettings().catch(() => {});
}

export async function fetchTanksValvesGeojson(
  args: { farm?: string } = {},
): Promise<GeoJsonFC> {
  const key = `tanks:${args.farm || ""}`;
  return cached(key, async () => {
    try {
      const r = await call<GeoJsonFC>(
        "upande_scp.serverscripts.get_tanks_valves.get_tanks_valves_geojson",
        args,
      );
      return r || { type: "FeatureCollection", features: [] };
    } catch {
      return { type: "FeatureCollection", features: [] };
    }
  });
}

/**
 * Per-greenhouse trap list (structural — trap number, location, type).
 * The traps map plots one cluster per greenhouse using its zone centroid
 * because the Trap doctype itself doesn't carry coordinates.
 */
export interface TrapInfo {
  name: string;
  trap_number?: string;
  location?: string;
  type?: string;
}

export async function fetchTrapsByGreenhouse(): Promise<
  Record<string, { indoor: TrapInfo[]; outdoor: TrapInfo[] }>
> {
  return cached("traps_by_gh", async () => {
    try {
      const r = await call<
        Record<string, { indoor: TrapInfo[]; outdoor: TrapInfo[] }>
      >(
        "upande_scp.serverscripts.scouting_metrics_api.get_traps_by_greenhouse",
        {},
      );
      return r || {};
    } catch {
      return {};
    }
  });
}

export function metaFromChunk(r: ChunkResponse): Partial<ScoutingMeta> {
  const pestColors: Record<string, string> = {};
  (r.pest_colors || []).forEach((p) => {
    if (p.name && p.pests_legend_color) pestColors[p.name] = p.pests_legend_color;
  });
  const diseaseColors: Record<string, string> = {};
  (r.disease_colors || []).forEach((d) => {
    if (d.name && d.disease_legend_color)
      diseaseColors[d.name] = d.disease_legend_color;
  });
  return {
    pestColors,
    diseaseColors,
    zonesByGreenhouse: r.zones_by_greenhouse || {},
    unitsByGreenhouse: r.units_by_greenhouse || {},
    cropsScouted: r.crops_scouted || [],
  };
}
