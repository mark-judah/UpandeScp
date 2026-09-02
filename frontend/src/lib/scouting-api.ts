import { isStaleSession, call } from "./frappe";
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
import { expandTreeRows, type OrchardTreeRow } from "./orchard-rows";

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

/**
 * Normalize the raw server rows into ``ScoutingEntry`` records.
 *
 * Used to also build six aggregate structures here (pests/diseases/traps/
 * greenhouses/scouts/daily) on every call, but none of the five scouting
 * dashboard pages (RoseScouting, Observations, TrapsMap, AvocadoHeatMap,
 * AvocadoTreeMap) ever read them — each derives its own view straight from
 * ``data.entries``. Re-verified against the whole frontend/src tree before
 * deleting: no consumer reaches ``.pests``/``.diseases``/``.traps``/
 * ``.greenhouses``/``.scouts``/``.daily`` off a ``useScouting`` payload.
 */
export function buildScoutingData(rawEntries: RawEntry[]): ProcessedData {
  return { entries: normalizeScoutingEntries(rawEntries) };
}

/* ---------- API helpers ---------- */

export async function fetchChunk(
  fromDate: string,
  toDate: string,
  greenhouse?: string,
): Promise<ChunkResponse> {
  const r = await call<ChunkResponse>(
    "upande_scp.serverscripts.scouting.get_complete_scouting_entries.getScoutingEntriesChunk",
    {
      from_date: fromDate,
      to_date: toDate,
      greenhouse: greenhouse || undefined,
      include_meta: 1,
    },
  );
  return (r || {}) as ChunkResponse;
}

/** Thrown-away errors here used to render as "No farms configured", which is a
 *  claim about the data when the truth was "the request failed". Callers that
 *  need to tell the difference should use `fetchFarmsAndWarehousesResult`. */
export async function fetchFarmsAndWarehouses(
  crop?: string,
): Promise<Record<string, string[]>> {
  return (await fetchFarmsAndWarehousesResult(crop)).farms;
}

export interface FarmsResult {
  farms: Record<string, string[]>;
  /** set when the request itself failed — distinct from "there are no farms" */
  error?: "stale-session" | "failed";
}

/** `crop` narrows the list to the farms that crop is grown on — the "where you are"
 *  filter. The server applies the "who you are" filter regardless, so omitting it
 *  never widens what comes back. */
export async function fetchFarmsAndWarehousesResult(
  crop?: string,
): Promise<FarmsResult> {
  try {
    const r = await call<Record<string, string[]>>(
      "upande_scp.serverscripts.scouting.scouting_metrics_api.get_farms_and_warehouses",
      crop ? { crop } : {},
    );
    return { farms: r || {} };
  } catch (e) {
    return {
      farms: {},
      error: isStaleSession(e) ? "stale-session" : "failed",
    };
  }
}


export async function fetchCrops(): Promise<
  Array<{ name: string; crop_name: string; farms?: string[] }>
> {
  try {
    const r = await call<
      Array<{ name: string; crop_name: string; farms?: string[] }>
    >("upande_scp.serverscripts.scouting.scouting_metrics_api.get_crops_with_farms", {});
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
/* Dedupe concurrent callers: if two components mount and both ask for the
 * same key before the network responds, share the single in-flight promise. */
const inFlight = new Map<string, Promise<unknown>>();

async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = refCache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.ts < REFERENCE_TTL_MS) return hit.value;
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = loader()
    .then((value) => {
      refCache.set(key, { ts: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

/* Seed refCache from the JSON the Frappe scp_app.py page inlines into the
 * HTML shell (``window.SCP.prefetch``). When present, ApplicationPlan and the
 * sidebar primers find their reference payloads already warm and skip the
 * first-paint network round-trip entirely. Safe to call multiple times. */
export function hydrateFromPrefetch(): void {
  if (typeof window === "undefined") return;
  const pre = (window as unknown as { SCP?: { prefetch?: Record<string, unknown> } })
    .SCP?.prefetch;
  if (!pre || typeof pre !== "object") return;
  const ts = Date.now();
  for (const [key, value] of Object.entries(pre)) {
    if (value == null) continue;
    if (refCache.has(key)) continue;
    refCache.set(key, { ts, value });
  }
}

// Hydrate eagerly at module load so the first call into any cached() helper
// already sees the seeded values — even if React hasn't rendered yet.
hydrateFromPrefetch();

export interface ZoneGeom {
  name: string;
  /** 2-point ``[[lng,lat],[lng,lat]]`` line — the zone's bed-line segment. */
  coords: [[number, number], [number, number]];
  /** Shared bed identifier (``properties.line_id`` in the old GeoJSON). */
  lineId: unknown;
}

export interface BedZoneNode {
  name: string;
  zones: ZoneGeom[];
}

export interface VarietyNode {
  variety: string;
  beds: BedZoneNode[];
}

/**
 * Compact per-bed wire entry from ``getBedsAndZones`` v2:
 *   [bedName, lineId, [x0,y0], endsOrPairs, nameSuffixes, contiguous]
 * Mirrors ``upande_scp.serverscripts.geo.zone_encoding.decode_bed`` — see
 * that module for the full format writeup. Decoding happens once, here,
 * so every consumer downstream reads plain ``coords``/``lineId`` and never
 * touches a GeoJSON string.
 */
type EncodedBedEntry = [
  string,
  unknown,
  [number, number],
  Array<[number, number]> | Array<[[number, number], [number, number]]>,
  string[],
  0 | 1,
];

function decodeBedEntry(entry: EncodedBedEntry): ZoneGeom[] {
  const [bedName, lineId, startPoint, endsOrPairs, nameSuffixes, contiguous] = entry;
  const zones: ZoneGeom[] = [];
  const isDigits = (s: string) => /^[0-9]+$/.test(s);

  if (contiguous) {
    let prev: [number, number] = startPoint;
    const points = endsOrPairs as Array<[number, number]>;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const suffix = nameSuffixes[i];
      const name = isDigits(suffix) ? `${bedName} - Zone ${suffix}` : suffix;
      zones.push({ name, coords: [prev, point], lineId });
      prev = point;
    }
  } else {
    const pairs = endsOrPairs as Array<[[number, number], [number, number]]>;
    for (let i = 0; i < pairs.length; i++) {
      const [start, end] = pairs[i];
      const suffix = nameSuffixes[i];
      const name = isDigits(suffix) ? `${bedName} - Zone ${suffix}` : suffix;
      zones.push({ name, coords: [start, end], lineId });
    }
  }
  return zones;
}

interface BedsAndZonesV2 {
  v: 2;
  varieties: Array<{ variety: string; beds: EncodedBedEntry[] }>;
}

function decodeBedsAndZonesV2(payload: unknown): VarietyNode[] {
  const p = payload as Partial<BedsAndZonesV2> | null | undefined;
  if (!p || p.v !== 2 || !Array.isArray(p.varieties)) {
    throw new Error(
      `getBedsAndZones: unrecognised payload shape (expected v:2, got ${JSON.stringify(
        (p as any)?.v,
      )})`,
    );
  }
  return p.varieties.map((v) => ({
    variety: v.variety,
    beds: (v.beds || []).map((entry) => ({
      name: entry[0],
      zones: decodeBedEntry(entry),
    })),
  }));
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
// v2: zones are now {name, coords, lineId} decoded from the compact
// getBedsAndZones payload, not {name, raw_geojson}. Bumped so any IDB row
// cached under the old shape is discarded rather than fed to consumers
// that no longer know about raw_geojson.
const BEDS_ZONES_VERSION = 2;
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
  let raw: unknown;
  try {
    const r = await call<{ data: unknown } | unknown>(
      "upande_scp.serverscripts.geo.get_beds_and_zones.getBedsAndZones",
      {},
    );
    raw = (r as { data?: unknown })?.data !== undefined ? (r as { data: unknown }).data : r;
  } catch {
    // Network/transport failure — no data to show, but not a shape problem;
    // callers already treat an empty result as "geometry not ready yet".
    return [];
  }
  if (!raw) return [];
  // Shape mismatches (stale v1 cache leaking through, server rollback, a
  // future v3) are NOT swallowed here — they throw, so a bad payload fails
  // loudly (visible error) instead of silently rendering an empty map.
  return decodeBedsAndZonesV2(raw);
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
 * Warm the avocado 3D-map geometry (blocks / orchard trees / tanks) into the
 * reference cache, the same way ``primeBedsAndZones`` warms the rose map.
 * Call this when the avocado section is entered so the map's own fetch finds
 * the payloads already cached (or shares the in-flight request) instead of
 * paying a cold round-trip — the orchard-tree layer especially can be large.
 */
export function primeAvocadoGeo(): void {
  // Blocks + tanks only. Orchard trees are per-farm (the unfiltered call
  // returns nothing), so they're loaded lazily once a farm is picked.
  void fetchBlocksGeojson().catch(() => {});
  void fetchTanksValvesGeojson().catch(() => {});
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
        "upande_scp.serverscripts.scouting.scouting_metrics_api.get_zone_counts_by_greenhouse",
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
        "upande_scp.serverscripts.scouting.scouting_metrics_api.get_scout_lookup",
        {},
      );
      return r || {};
    } catch {
      return {};
    }
  });
}

/**
 * One sprayer GPS fix as stored by the mobile app. The server already maps each
 * point to the nearest Zone (no bed filter), so `zone` is populated for us.
 */
export interface SprayerGpsLog {
  name: string;
  session: string;
  employee: string;
  greenhouse: string;
  work_order: string;
  captured_at: string;
  latitude: string;
  longitude: string;
  zone: string | null;
  gps_accuracy: string | null;
}

/**
 * Sprayer GPS logs for a date range (optionally one greenhouse), oldest-first.
 * Read straight off the `Sprayer GPS Log` doctype via the generic list API —
 * no bespoke server method needed. The Spraying map caps the range to a week.
 */
export async function fetchSprayerGpsLogs(
  fromDate: string,
  toDate: string,
  greenhouse?: string,
): Promise<SprayerGpsLog[]> {
  const filters: unknown[] = [
    ["captured_at", "between", [`${fromDate} 00:00:00`, `${toDate} 23:59:59`]],
  ];
  if (greenhouse) filters.push(["greenhouse", "=", greenhouse]);
  try {
    const r = await call<SprayerGpsLog[]>("frappe.client.get_list", {
      doctype: "Sprayer GPS Log",
      filters,
      fields: [
        "name",
        "session",
        "employee",
        "greenhouse",
        "work_order",
        "captured_at",
        "latitude",
        "longitude",
        "zone",
        "gps_accuracy",
      ],
      order_by: "captured_at asc",
      limit_page_length: 0,
    });
    return Array.isArray(r) ? r : [];
  } catch {
    return [];
  }
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
        "upande_scp.serverscripts.geo.get_orchard_trees.get_orchard_trees_geojson",
        args,
      );
      return r || { type: "FeatureCollection", features: [] };
    } catch {
      return { type: "FeatureCollection", features: [] };
    }
  });
}

/** Lean orchard-tree payload for the 3D map: parallel ``names`` + flat
 *  ``coords`` ([lng0,lat0,lng1,lat1,…]) arrays instead of a FeatureCollection
 *  of ~50k nested features — several times smaller to transfer and parse. */
export interface OrchardTreePoints {
  names: string[];
  coords: number[];
}

export async function fetchOrchardTreePoints(
  args: { block?: string; farm?: string } = {},
): Promise<OrchardTreePoints> {
  const key = `orchard_pts:${args.block || ""}:${args.farm || ""}`;
  return cached(key, async () => {
    try {
      const r = await call<OrchardTreePoints>(
        "upande_scp.serverscripts.geo.get_orchard_trees.get_orchard_tree_points",
        args,
      );
      return r && Array.isArray(r.coords) ? r : { names: [], coords: [] };
    } catch {
      return { names: [], coords: [] };
    }
  });
}

/** Row-interpolated orchard-tree payload for the 3D map: per-row endpoints
 *  (or explicit coords for obstacle rows), expanded client-side into the same
 *  ``{names, coords}`` shape as ``fetchOrchardTreePoints`` but a fraction of the
 *  bytes. See ``get_orchard_tree_rows`` + ``expandTreeRows``. */
export async function fetchOrchardTreeRows(
  args: { block?: string; farm?: string } = {},
): Promise<OrchardTreePoints> {
  const key = `orchard_rows:${args.block || ""}:${args.farm || ""}`;
  return cached(key, async () => {
    try {
      const r = await call<{ rows: OrchardTreeRow[] }>(
        "upande_scp.serverscripts.geo.get_orchard_trees.get_orchard_tree_rows",
        args,
      );
      return r && Array.isArray(r.rows)
        ? expandTreeRows(r.rows)
        : { names: [], coords: [] };
    } catch {
      return { names: [], coords: [] };
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
  /** ERPNext's allowed UOMs for the item, `conversion_factor` = stock-UOM qty
   *  per 1 of that UOM. Empty/absent means only the stock UOM applies. */
  uoms?: Array<{ uom: string; conversion_factor: number }>;
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
  /** ERPNext's allowed UOMs for the item — see BomChemical.uoms. */
  uoms?: Array<{ uom: string; conversion_factor: number }>;
  item_group?: string;
  is_fertilizer?: boolean;
}

export async function searchChemicalItems(
  q?: string,
): Promise<ChemicalItem[]> {
  try {
    return await call<ChemicalItem[]>(
      "upande_scp.serverscripts.scouting.scouting_metrics_api.list_chemical_items",
      { q: q || undefined, limit: 50 },
    );
  } catch {
    return [];
  }
}

/** Per-warehouse stock balances for ad-hoc item codes. Same shape as the
 *  ``balances`` field on a BOM-loaded chemical: ``{warehouse: qty}``. Used
 *  when the operator adds a chemical that isn't already exploded into the
 *  BOM, so the Chemical Stock matrix shows real stock instead of zeros. */
export async function fetchChemicalBalances(
  itemCodes: string[],
): Promise<Record<string, Record<string, number>>> {
  if (!itemCodes.length) return {};
  try {
    return (
      (await call<Record<string, Record<string, number>>>(
        "upande_scp.serverscripts.scouting.scouting_metrics_api.get_chemical_stock_balances",
        { item_codes: itemCodes },
      )) || {}
    );
  } catch {
    return {};
  }
}

/** Per-chemical application-rate limits keyed by ``item_code``. Chemicals
 *  whose Item has neither limit set are omitted, so callers can treat an
 *  absent entry as "no bound". */
export type RateLimit = {
  lower: number | null;
  upper: number | null;
  label: string;
};

export async function fetchChemicalRateLimits(): Promise<
  Record<string, RateLimit>
> {
  return cached("chemical_rate_limits", async () => {
    try {
      return (
        (await call<Record<string, RateLimit>>(
          "upande_scp.serverscripts.store.create_bom.get_chemical_rate_limits",
          {},
        )) || {}
      );
    } catch {
      return {};
    }
  });
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
  greenhouse?: string,
): Promise<BomDetails | null> {
  if (!name) return null;
  // Keyed by greenhouse too — a farm-mapped store restricts the returned
  // warehouse lists, so the same BOM fetched for two different greenhouses
  // can legitimately return different ``chemical_warehouses``/balances.
  // Deliberately NOT swallowing the error. Returning null on failure meant two
  // things at once: the panel rendered blank with no message, and `cached`
  // stored the null — so a single server error kept the chemicals panel empty
  // for the whole cache TTL, even once the server was fixed. Letting it throw
  // both surfaces the failure and keeps the failure out of the cache (`cached`
  // only writes on resolve).
  return cached(`bom:${name}:${greenhouse || ""}`, () =>
    call<BomDetails>(
      "upande_scp.serverscripts.scouting.scouting_metrics_api.get_bom_details",
      { name, greenhouse: greenhouse || undefined },
    ),
  );
}

/** Reserved qty per item at one source warehouse, from Application Floor
 *  Plan work orders that are drafted/submitted but not yet material-issued.
 *  Used to keep the Chemical Stock matrix's "available" figure honest
 *  across successive plans in the same session (the "5kg→60kg" bug). */
export async function getStoreReservations(
  warehouse: string,
  itemCodes: string[],
): Promise<Record<string, number>> {
  if (!warehouse || !itemCodes.length) return {};
  try {
    return (
      (await call<Record<string, number>>(
        "upande_scp.serverscripts.spray_plan_creator.reservations.get_store_reservations",
        { warehouse, item_codes: itemCodes },
      )) || {}
    );
  } catch {
    return {};
  }
}

export async function fetchApplicationPlanBootstrap(): Promise<PlanBootstrap> {
  return cached("plan_bootstrap", async () => {
    try {
      const r = await call<PlanBootstrap>(
        "upande_scp.serverscripts.scouting.scouting_metrics_api.get_application_plan_bootstrap",
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
        "upande_scp.serverscripts.scouting.scouting_metrics_api.get_beds_by_greenhouse",
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
    /** Dose per 1000 L. This is the field `create_bom.createBOM` actually
     *  reads, and it rejects the row outright when it is missing or <= 0
     *  ("Rate must be > 0 for '<name>' (row #n)"). The dialog used to send
     *  only `qty: 1`, so every BOM creation failed for every user. */
    custom_application_rate: number;
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
      "upande_scp.serverscripts.store.create_bom.createBOM",
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
        "upande_scp.serverscripts.scouting.scouting_metrics_api.get_blocks_geojson",
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
      "upande_scp.serverscripts.scouting.scouting_metrics_api.get_map_settings",
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
        "upande_scp.serverscripts.geo.get_tanks_valves.get_tanks_valves_geojson",
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
        "upande_scp.serverscripts.scouting.scouting_metrics_api.get_traps_by_greenhouse",
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
