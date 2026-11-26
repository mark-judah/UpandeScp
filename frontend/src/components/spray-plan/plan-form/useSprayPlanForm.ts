/**
 * One spray plan's form state: tank mix (BOM), chemical rows, water, batch picks,
 * classification, team, kit, method of application and Scheduled Application —
 * plus the draft-aware stock logic the roses Application Plan built (Available net of
 * other draft plans, batch pre-selection, the batch / stock submit gates).
 *
 * Moved out of `pages/ApplicationPlan.tsx` so the roses greenhouse plan and every
 * selected block of the field Application Floor Plan run the same code:
 *
 *  - placeKind "greenhouse": a chemical's rate is per 1000 L and its total is
 *    rate x water / 1000, kept on the row (`stock_qty`) exactly as roses did.
 *  - placeKind "block": a chemical's rate is per its own unit (lib/spray-rates) and the
 *    quantity is worked out from the block's area or the typed water (lib/open-field
 *    `chemicalQty`), never stored.
 *
 * State is held here (roses) or by the caller through `value` / `onChange` (the field
 * planner keeps every block's plan so it can send them together).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBomDetails,
  fetchChemicalBalances,
  getItemAvailability,
  type BatchAvailability,
  type BomDetails,
  type ChemicalItem,
  type ItemAvailability,
  type RateLimit,
} from "@/lib/scouting-api";
import { availableStock, itemNeedsBatch } from "@/lib/stock-availability";
import {
  chemicalQty,
  emptyPlan,
  planFieldProblems,
  stockKey,
  typedWater,
  withRateRows,
  type BlockChemical,
  type BlockPlan,
  type FieldProblem,
} from "@/lib/open-field";
import { fetchSprayProductRates, type RateRow } from "@/lib/spray-rates";
import { errorText } from "@/lib/errors";
import { todayAt } from "@/lib/utils";

/** Litres of water per hectare / the per-1000 L unit of a greenhouse tank-mix rate —
 *  same constant the legacy ``new_application_floor_plan.js`` used. */
export const WATER_VOLUME_RATE = 1000;

export type PlaceKind = "greenhouse" | "block";
export type PlanChemical = BlockChemical;
export type PlanValue = BlockPlan;

export interface FarmStores {
  chemical_store?: string | null;
  fertilizer_store?: string | null;
}

export interface SprayPlanFormOptions {
  /** the greenhouse or block planned (custom_greenhouse) */
  place: string;
  placeKind: PlaceKind;
  /** the crop whose rate rows apply (block plans) */
  crop?: string | null;
  farm: string;
  /** the area sprayed, hectares (block plans measure Area rates against it) */
  areaHa: number;
  /** unsaved quantities other plans in the same batch draw, "store::item" -> qty */
  reservedElsewhere?: Record<string, number>;
  /** the farm's mapped stores: when set, a row's source is locked to them */
  stores?: FarmStores | null;
  /** per-1000 L limits per item (greenhouse rate inputs) */
  rateLimits?: Record<string, RateLimit>;
  /** controlled: the plan and where its changes go */
  value?: PlanValue;
  onChange?: (next: PlanValue) => void;
  /** the Scheduled Application shown when the plan has none */
  defaultScheduledAt?: string;
}

type Upd<T> = T | ((cur: T) => T);

export interface StockShortRow {
  rowId: string;
  name: string;
  source: string;
  avail: number;
  need: number;
}

export interface PlanFormState {
  placeKind: PlaceKind;
  place: string;
  farm: string;
  areaHa: number;
  crop?: string | null;
  value: PlanValue;
  stores: FarmStores | null;
  rateLimits: Record<string, RateLimit>;
  reset: () => void;

  bom: string;
  setBom: (bom: string) => void;
  bomDetails: BomDetails | null;
  bomLoading: boolean;
  bomError: string | null;

  chemicals: PlanChemical[];
  setChemicals: (v: Upd<PlanChemical[]>) => void;
  addChemical: (item: ChemicalItem, defaultRate?: number | null, fromStore?: string) => Promise<void>;
  makeChemRow: (
    item: ChemicalItem,
    defaultRate: number | null | undefined,
    fromStore: string | undefined,
    position: number,
  ) => Promise<PlanChemical>;
  removeChemical: (rowId: string) => void;
  setRate: (rowId: string, rate: number) => void;
  setBatch: (rowId: string, batch: string) => void;
  setSource: (rowId: string, source: string) => void;
  setUom: (rowId: string, uom: string) => void;
  rowKey: (c: PlanChemical, i: number) => string;

  water: string;
  setWater: (v: Upd<string>) => void;
  waterPh: string;
  setWaterPh: (v: Upd<string>) => void;
  waterHardness: string;
  setWaterHardness: (v: Upd<string>) => void;
  area: string;
  setArea: (v: Upd<string>) => void;
  method: string;
  setMethod: (v: Upd<string>) => void;
  scheduledAt: string;
  setScheduledAt: (v: Upd<string>) => void;
  classification: PlanValue["classification"];
  setClassification: (v: PlanValue["classification"]) => void;
  reason: string;
  setReason: (v: Upd<string>) => void;
  team: string;
  setTeam: (v: Upd<string>) => void;
  /** the plan's crew: names and roles under the team pill */
  members: NonNullable<PlanValue["members"]>;
  setMembers: (v: Upd<NonNullable<PlanValue["members"]>>) => void;
  kit: string;
  setKit: (v: Upd<string>) => void;
  targets: string[];
  setTargets: (v: Upd<string[]>) => void;

  /** the quantity a row draws (stock UOM) */
  qtyOf: (c: PlanChemical) => number;
  availability: Record<string, ItemAvailability>;
  rowAvailable: (c: PlanChemical) => number;
  remainingFor: (c: PlanChemical) => { after: number; ifAll: number; a: ItemAvailability } | null;
  batchTone: (b: BatchAvailability, need: number) => string;
  needsBatch: (c: PlanChemical) => boolean;
  batchMissingRows: PlanChemical[];
  stockShortRows: StockShortRow[];
  stockShortById: Set<string>;
  /** this plan's own draw, "store::item" -> qty (for the other plans' Available) */
  reservedQty: Record<string, number>;
  /** what the plan still needs (block plans) */
  problems: string[];
  /** the same, per form field (block plans): drives the required marks */
  fieldProblems: FieldProblem[];

  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
  addNotice: string;
  setAddNotice: (v: string) => void;
}

const freshPlan = (at: string): PlanValue => ({
  ...emptyPlan(),
  scheduledAt: at,
  waterPh: "",
  waterHardness: "",
});

export function useSprayPlanForm(opts: SprayPlanFormOptions): PlanFormState {
  const { place, placeKind, farm, areaHa, crop } = opts;
  const block = placeKind === "block";
  const controlled = !!opts.onChange && !!opts.value;
  const defaultAt = opts.defaultScheduledAt || todayAt("06:00");

  const [inner, setInner] = useState<PlanValue>(() => opts.value ?? freshPlan(defaultAt));
  const value = controlled ? (opts.value as PlanValue) : inner;

  // Latest plan for event handlers and async loads. A controlled caller may not have
  // re-rendered yet with the last change, so the ref, not the prop, is the base.
  const ref = useRef<PlanValue>(value);
  const lastProp = useRef<PlanValue | undefined>(opts.value);
  if (controlled && opts.value !== lastProp.current) {
    lastProp.current = opts.value;
    ref.current = opts.value as PlanValue;
  }
  if (!controlled) ref.current = inner;
  const onChangeRef = useRef(opts.onChange);
  onChangeRef.current = opts.onChange;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const update = useCallback((fn: (v: PlanValue) => PlanValue) => {
    if (controlledRef.current) {
      const next = fn(ref.current);
      if (next === ref.current) return;
      ref.current = next;
      onChangeRef.current?.(next);
    } else {
      setInner((prev) => fn(prev));
    }
  }, []);

  const field = useCallback(
    <K extends keyof PlanValue>(k: K) =>
      (v: Upd<NonNullable<PlanValue[K]>>) =>
        update((p) => {
          const cur = p[k] as NonNullable<PlanValue[K]>;
          const nv = typeof v === "function" ? (v as (c: typeof cur) => typeof cur)(cur) : v;
          return nv === p[k] ? p : { ...p, [k]: nv };
        }),
    [update],
  );
  const setters = useMemo(
    () => ({
      setChemicals: field("chemicals"),
      setWater: field("water"),
      setWaterPh: field("waterPh"),
      setWaterHardness: field("waterHardness"),
      setArea: field("area"),
      setMethod: field("method"),
      setScheduledAt: (v: Upd<string>) =>
        update((p) => {
          const cur = p.scheduledAt || optsRef.current.defaultScheduledAt || todayAt("06:00");
          const nv = typeof v === "function" ? v(cur) : v;
          return nv === p.scheduledAt ? p : { ...p, scheduledAt: nv };
        }),
      setReason: field("reason"),
      setTeam: field("team"),
      setMembers: field("members"),
      setKit: field("kit"),
      setTargets: field("targets"),
    }),
    [field, update],
  );

  // ── Tank mix (BOM) ────────────────────────────────────────────────
  const [bomDetails, setBomDetails] = useState<BomDetails | null>(null);
  const [bomLoading, setBomLoading] = useState(false);
  // Why the load failed, if it did. Without this the panel just went blank and
  // the operator had no way to tell a broken endpoint from an empty tank mix.
  const [bomError, setBomError] = useState<string | null>(null);
  const bomDetailsRef = useRef<BomDetails | null>(null);
  bomDetailsRef.current = bomDetails;
  const loadSeq = useRef(0);

  /** Load a tank mix's details; unless `keepRows`, its chemicals become the plan's rows. */
  const loadBom = useCallback(
    (bom: string, keepRows = false) => {
      const seq = ++loadSeq.current;
      if (!bom) {
        setBomDetails(null);
        setBomError(null);
        setBomLoading(false);
        return;
      }
      const o = optsRef.current;
      // Rows already in hand (a block picked again) stay on screen while the
      // details (warehouse lists) reload: no skeleton over them.
      setBomLoading(!keepRows);
      setBomError(null);
      // Pass the picked place so a farm-mapped store already collapses
      // the returned warehouse lists (and balances) server-side (Task 6).
      fetchBomDetails(bom, o.place)
        .then(async (d) => {
          if (seq !== loadSeq.current || !d) return;
          setBomDetails(d);
          if (keepRows) return;
          const stores = o.stores;
          let rows: PlanChemical[] = d.chemicals.map((c, i) => {
            const balances = c.balances || {};
            const first = Object.entries(balances).find(([, v]) => v > 0);
            const fallback = c.is_fertilizer ? d.fertilizer_warehouses : d.chemical_warehouses;
            // ``c.stock_qty`` from the BOM is the per-1000 L Tank-Mix rate.
            // It becomes the row's editable ``rate``; the total is derived from it.
            const bomRate = Number(c.stock_qty) || 0;
            // Store lock (Task 9): when the farm has a mapped store for
            // this chemical's group, the source isn't a free choice.
            const forcedSource = c.is_fertilizer ? stores?.fertilizer_store : stores?.chemical_store;
            return {
              ...c,
              basis: "Water" as const,
              rowId: `${c.item_code}-${i}`,
              source: forcedSource || first?.[0] || (fallback?.length ? fallback[0] : ""),
              rate: bomRate,
              stock_qty: 0,
            };
          });
          if (o.placeKind === "block") {
            // The tank mix's own rate is per 1000 L of water. Where the product has an Area
            // rate for this block's crop, the block's area decides the quantity instead.
            const rates = await fetchSprayProductRates(
              rows.map((c) => c.item_code),
              o.crop || "",
            ).catch((): Record<string, RateRow[]> => ({}));
            if (seq !== loadSeq.current) return;
            rows = rows.map((c) => withRateRows(c, rates[c.item_code]));
          }
          update((p) => ({
            ...p,
            bom,
            chemicals: rows,
            ...(o.placeKind === "greenhouse"
              ? {
                  waterPh: d.custom_water_ph?.toString() || "",
                  waterHardness: d.custom_water_hardness?.toString() || "",
                }
              : {}),
          }));
        })
        .catch((e: unknown) => {
          if (seq !== loadSeq.current) return;
          setBomDetails(null);
          update((p) => (p.chemicals.length ? { ...p, chemicals: [] } : p));
          setBomError(errorText(e, "Could not load this tank mix's chemicals. Try again, or pick another mix."));
        })
        .finally(() => {
          if (seq === loadSeq.current) setBomLoading(false);
        });
    },
    [update],
  );

  const setBom = useCallback(
    (bom: string) => {
      if (bom === ref.current.bom && (bom === "" || bomDetailsRef.current?.name === bom)) return;
      update((p) => ({
        ...p,
        bom,
        chemicals: [],
        ...(!bom && optsRef.current.placeKind === "greenhouse" ? { waterPh: "", waterHardness: "" } : {}),
      }));
      loadBom(bom);
    },
    [update, loadBom],
  );

  // A plan that arrives with a tank mix (a block picked again) keeps its rows; the
  // details are still needed for the warehouse lists.
  useEffect(() => {
    if (ref.current.bom) loadBom(ref.current.bom, ref.current.chemicals.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A greenhouse plan reloads its tank mix when the house or its farm's stores change
  // (balances and the store lock are per house), as the roses page always did.
  const chemStore = opts.stores?.chemical_store || "";
  const fertStore = opts.stores?.fertilizer_store || "";
  const firstPlace = useRef(true);
  useEffect(() => {
    if (firstPlace.current) {
      firstPlace.current = false;
      return;
    }
    if (!block && ref.current.bom) loadBom(ref.current.bom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, chemStore, fertStore]);

  // Safety net: if the farm mapping resolves after rows are already populated,
  // snap any locked group's source back to the mapped store instead of leaving a
  // stale pick from before the mapping was known.
  useEffect(() => {
    if (!chemStore && !fertStore) return;
    update((p) => {
      let changed = false;
      const next = p.chemicals.map((c) => {
        const forced = c.is_fertilizer ? fertStore : chemStore;
        if (!forced || c.source === forced) return c;
        changed = true;
        return { ...c, source: forced };
      });
      return changed ? { ...p, chemicals: next } : p;
    });
  }, [chemStore, fertStore, update]);

  // ── Quantities ────────────────────────────────────────────────────
  const water = value.water;
  // Greenhouse: each row's total ``stock_qty`` is its per-1000-L ``rate`` scaled by
  // the water volume. The rate is the operator's source of truth; this keeps the
  // total in sync whenever the water volume changes — and when a tank mix's rows
  // arrive after the water was already set (they land with a 0 total).
  const unpricedRows = value.chemicals.filter((c) => Number(c.rate) && !c.stock_qty).length;
  useEffect(() => {
    if (block) return;
    const wv = parseFloat(water) || 0;
    if (wv <= 0) return;
    const ratio = wv / WATER_VOLUME_RATE; // 1 = BOM batch is "per 1000 L"
    update((p) => {
      let changed = false;
      const next = p.chemicals.map((c) => {
        const rate = Number(c.rate ?? 0);
        if (!rate) return c;
        const q = Math.round(rate * ratio * 10000) / 10000;
        if (q === c.stock_qty) return c;
        changed = true;
        return { ...c, stock_qty: q };
      });
      return changed ? { ...p, chemicals: next } : p;
    });
  }, [water, block, update, unpricedRows]);

  const waterL = typedWater(value);
  const qtyOf = useCallback(
    (c: PlanChemical): number => (block ? chemicalQty(c, areaHa, waterL) : Number(c.stock_qty || 0)),
    [block, areaHa, waterL],
  );

  const rowKey = useCallback((c: PlanChemical, i: number) => c.rowId || `${c.item_code}-${i}`, []);
  const mapRow = useCallback(
    (rowId: string, fn: (c: PlanChemical) => PlanChemical) =>
      update((p) => ({
        ...p,
        chemicals: p.chemicals.map((c, i) => ((c.rowId || `${c.item_code}-${i}`) === rowId ? fn(c) : c)),
      })),
    [update],
  );

  /** Operator-edited rate. A greenhouse row recomputes its total in the same update so
   *  the stock figures follow without waiting for the water-volume effect. */
  const setRate = useCallback(
    (rowId: string, nextRate: number) => {
      const rate = Number.isFinite(nextRate) ? nextRate : 0;
      if (optsRef.current.placeKind === "block") {
        mapRow(rowId, (r) => ({ ...r, rate }));
        return;
      }
      const wv = parseFloat(ref.current.water) || 0;
      const ratio = wv > 0 ? wv / WATER_VOLUME_RATE : 0;
      mapRow(rowId, (r) => ({
        ...r,
        rate,
        stock_qty: ratio ? Math.round(rate * ratio * 10000) / 10000 : 0,
      }));
    },
    [mapRow],
  );
  const removeChemical = useCallback(
    (rowId: string) =>
      update((p) => ({
        ...p,
        chemicals: p.chemicals.filter((c, i) => (c.rowId || `${c.item_code}-${i}`) !== rowId),
      })),
    [update],
  );
  const [batchTouched, setBatchTouched] = useState<Set<string>>(new Set());
  const setBatch = useCallback(
    (rowId: string, batch: string) => {
      setBatchTouched((t) => new Set(t).add(rowId));
      mapRow(rowId, (r) => ({ ...r, batch_no: batch }));
    },
    [mapRow],
  );
  const setSource = useCallback((rowId: string, source: string) => mapRow(rowId, (r) => ({ ...r, source })), [mapRow]);
  const setUom = useCallback((rowId: string, uom: string) => mapRow(rowId, (r) => ({ ...r, stock_uom: uom })), [mapRow]);

  // ── Add chemical ──────────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addNotice, setAddNotice] = useState<string>("");

  /** A new tank-mix row for `item`: real per-warehouse balances, the farm's store lock,
   *  and, for a suggested product, its default (lower-limit) rate with the total taken
   *  from the plan's water volume exactly as setRate does. */
  const makeChemRow = useCallback(
    async (
      item: ChemicalItem,
      defaultRate: number | null | undefined,
      fromStore: string | undefined,
      position: number,
    ): Promise<PlanChemical> => {
      const o = optsRef.current;
      const d = bomDetailsRef.current;
      const fallbackList = item.is_fertilizer ? d?.fertilizer_warehouses : d?.chemical_warehouses;
      // Pull real per-warehouse balances so the stock figures don't read zero for an
      // item that's actually in stock. The BOM-load path gets this from
      // ``get_bom_details``; ad-hoc adds need an explicit fetch.
      const balancesByCode = await fetchChemicalBalances([item.item_code]);
      const balances = balancesByCode[item.item_code] || {};
      const firstWithStock = Object.entries(balances).find(([, v]) => v > 0);
      // Store lock (Task 9): ad-hoc adds go through the same lock as
      // BOM-exploded rows when the farm has a mapped store for this group.
      const forcedSource = item.is_fertilizer ? o.stores?.fertilizer_store : o.stores?.chemical_store;
      const startRate = defaultRate && defaultRate > 0 ? defaultRate : 0;
      const wvNow = parseFloat(ref.current.water) || 0;
      const startQty =
        startRate && wvNow > 0 ? Math.round(startRate * (wvNow / WATER_VOLUME_RATE) * 10000) / 10000 : 0;
      let row: PlanChemical = {
        item_code: item.item_code,
        item_name: item.item_name,
        stock_uom: item.stock_uom,
        uoms: item.uoms,
        item_group: item.item_group,
        is_fertilizer: item.is_fertilizer,
        basis: "Water",
        rowId: `${item.item_code}-${Date.now()}-${position}`,
        source: forcedSource || fromStore || firstWithStock?.[0] || fallbackList?.[0] || "",
        balances,
        rate: startRate,
        stock_qty: startQty,
      };
      if (o.placeKind === "block") {
        // Put it on the block's Area rate when the product has one.
        const rates = await fetchSprayProductRates([item.item_code], o.crop || "").catch(
          (): Record<string, RateRow[]> => ({}),
        );
        row = withRateRows(row, rates[item.item_code]);
      }
      return row;
    },
    [],
  );

  const addChemical = useCallback(
    async (item: ChemicalItem, defaultRate?: number | null, fromStore?: string) => {
      if (ref.current.chemicals.some((r) => r.item_code === item.item_code)) {
        // Inline notice inside the dialog instead of a floating toast — the
        // operator's eye is already on the modal, so the feedback has to land
        // there, not at the page edge.
        setAddNotice(`${item.item_name || item.item_code} is already in your chemical plan.`);
        return;
      }
      setAddNotice("");
      setAddOpen(false);
      const row = await makeChemRow(item, defaultRate, fromStore, ref.current.chemicals.length);
      update((p) =>
        p.chemicals.some((r) => r.item_code === item.item_code) ? p : { ...p, chemicals: [...p.chemicals, row] },
      );
    },
    [makeChemRow, update],
  );

  // ── Draft-aware availability (Task 9) ─────────────────────────────
  // ``reserved`` holds server-side reservations from *other* still-open
  // Application Floor Plan work orders, keyed by "<source>::<item_code>"
  // so two rows that happen to pick different stores for the same item
  // aren't conflated. Refetched whenever the plan's (source, item) pairs
  // change, or a draft is just added to the batch.
  const [reserved, setReserved] = useState<Record<string, number>>({});
  const [availability, setAvailability] = useState<Record<string, ItemAvailability>>({});
  const [reservedRefreshTick, setReservedRefreshTick] = useState(0);

  useEffect(() => {
    const handler = () => setReservedRefreshTick((t) => t + 1);
    window.addEventListener("spray-plan:draft-added", handler);
    return () => window.removeEventListener("spray-plan:draft-added", handler);
  }, []);

  const chemicals = value.chemicals;
  // Stable string key so the reservation fetch only re-runs when the set
  // of (source, item) pairs actually changes, not on every rate keystroke.
  const sourceItemKey = useMemo(
    () =>
      chemicals
        .filter((c) => c.source && c.item_code)
        .map((c) => `${c.source}::${c.item_code}`)
        .sort()
        .join(","),
    [chemicals],
  );

  useEffect(() => {
    let cancelled = false;
    const bySource = new Map<string, Set<string>>();
    for (const pair of sourceItemKey ? sourceItemKey.split(",") : []) {
      const [source, item] = pair.split("::");
      if (!source || !item) continue;
      if (!bySource.has(source)) bySource.set(source, new Set());
      bySource.get(source)!.add(item);
    }
    if (!bySource.size) {
      setReserved({});
      setAvailability({});
      return;
    }
    Promise.all(
      Array.from(bySource.entries()).map(([source, codes]) =>
        getItemAvailability(source, Array.from(codes)).then((res) => ({ source, res })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const merged: Record<string, number> = {};
      const full: Record<string, ItemAvailability> = {};
      for (const { source, res } of results) {
        for (const [item, a] of Object.entries(res || {})) {
          merged[`${source}::${item}`] = a.reserved;
          full[`${source}::${item}`] = a;
        }
      }
      setReserved(merged);
      setAvailability(full);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceItemKey, reservedRefreshTick]);

  const elsewhere = opts.reservedElsewhere;
  /** Per-row "other rows in this form" usage of the same item+source —
   *  catches double-adding the same chemical in one plan before it's
   *  ever saved as a draft (the reservations query above only sees
   *  *saved* work orders) — plus what other plans in this batch draw. */
  const draftUsageByRowId = useMemo(() => {
    const out = new Map<string, number>();
    chemicals.forEach((c, i) => {
      const id = rowKey(c, i);
      if (!c.source || !c.item_code) {
        out.set(id, 0);
        return;
      }
      let sum = Number(elsewhere?.[stockKey(c.source, c.item_code)] ?? 0);
      chemicals.forEach((other, j) => {
        if (j === i) return;
        if (other.item_code === c.item_code && other.source === c.source) sum += qtyOf(other);
      });
      out.set(id, sum);
    });
    return out;
  }, [chemicals, qtyOf, rowKey, elsewhere]);

  const idOf = useCallback(
    (c: PlanChemical) => {
      const i = chemicals.indexOf(c);
      return rowKey(c, i < 0 ? 0 : i);
    },
    [chemicals, rowKey],
  );

  /** Reservation- and draft-aware available qty for one row: on-hand
   *  minus every other still-open work order's reservation at the same
   *  store, minus other rows (and other plans of this batch) drawing the
   *  same item from the same store. This — not raw on-hand — is what gates
   *  Submit. */
  const rowAvailable = useCallback(
    (c: PlanChemical): number => {
      const source = c.source || "";
      const onHand = Number(c.balances?.[source] ?? 0);
      const reservedQty = source && c.item_code ? Number(reserved[`${source}::${c.item_code}`] ?? 0) : 0;
      const draftUsage = draftUsageByRowId.get(idOf(c)) ?? 0;
      return availableStock({
        onHand,
        reservedFromServer: reservedQty,
        draftFormUsage: draftUsage,
      });
    },
    [reserved, draftUsageByRowId, idOf],
  );

  /** Both remaining figures for a row's item at its source: after this
   *  plan (other SUBMITTED plans only), and if every pending draft is also
   *  approved. Unfloored: a negative number is the shortfall. */
  const remainingFor = useCallback(
    (c: PlanChemical) => {
      const a = c.source && c.item_code ? availability[`${c.source}::${c.item_code}`] : undefined;
      if (!a) return null;
      const mine =
        chemicals
          .filter((o) => o.item_code === c.item_code && o.source === c.source)
          .reduce((n, o) => n + qtyOf(o), 0) + Number(elsewhere?.[stockKey(c.source, c.item_code)] ?? 0);
      return {
        after: a.ledger - a.reserved_submitted - mine,
        ifAll: a.ledger - a.reserved - mine,
        a,
      };
    },
    [availability, chemicals, qtyOf, elsewhere],
  );

  /** green = this batch alone covers the row, amber = partial, grey = none. */
  const batchTone = useCallback(
    (b: BatchAvailability, need: number) =>
      b.expired || b.zero_valued || b.available <= 0
        ? "text-muted-foreground"
        : b.available >= need
          ? "text-[var(--sd-data-green)]"
          : "text-amber-700 dark:text-amber-300",
    [],
  );

  const availOf = useCallback(
    (c: PlanChemical) => (c.source && c.item_code ? availability[`${c.source}::${c.item_code}`] : undefined),
    [availability],
  );
  const needsBatch = useCallback(
    (c: PlanChemical) => {
      const a = availOf(c);
      return !!a && itemNeedsBatch(a);
    },
    [availOf],
  );

  // Pre-select the best green batch once availability lands; drop a batch that
  // no longer belongs to the row's item/store. A hand-picked batch is kept.
  // A block plan also records whether the row must name a batch, so the planner
  // can gate a block whose form is not open.
  const qtyKey = chemicals.map((c, i) => `${rowKey(c, i)}:${qtyOf(c)}:${c.source}`).join("|");
  useEffect(() => {
    update((p) => {
      let changed = false;
      const next = p.chemicals.map((c, i) => {
        const a = c.source && c.item_code ? availability[`${c.source}::${c.item_code}`] : undefined;
        let row = c;
        if (block && a) {
          const req = itemNeedsBatch(a);
          if (!!c.batch_required !== req) row = { ...row, batch_required: req };
        }
        if (!a || !itemNeedsBatch(a)) {
          if (row !== c) changed = true;
          return row;
        }
        if (row.batch_no && !a.batches.some((b) => b.batch_no === row.batch_no)) {
          changed = true;
          return { ...row, batch_no: undefined };
        }
        const need = qtyOf(row);
        if (row.batch_no || batchTouched.has(rowKey(row, i)) || !need) {
          if (row !== c) changed = true;
          return row;
        }
        const best = a.batches.find((b) => !b.expired && !b.zero_valued && b.available >= need);
        if (!best) {
          if (row !== c) changed = true;
          return row;
        }
        changed = true;
        return { ...row, batch_no: best.batch_no };
      });
      return changed ? { ...p, chemicals: next } : p;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, batchTouched, qtyKey]);

  // A block plan records each row's free stock (on hand less saved open plans), so the
  // planner can apply the roses stock gate to a block whose form is not open.
  useEffect(() => {
    if (!block) return;
    update((p) => {
      let changed = false;
      const next = p.chemicals.map((c) => {
        if (!c.balances || !c.source || !c.item_code) return c;
        const free =
          Number(c.balances[c.source] ?? 0) - Number(reserved[`${c.source}::${c.item_code}`] ?? 0);
        if (c.stock_free === free) return c;
        changed = true;
        return { ...c, stock_free: free };
      });
      return changed ? { ...p, chemicals: next } : p;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reserved, sourceItemKey, block]);

  /** Batch-tracked rows with no batch confirmed block submission. */
  const batchMissingRows = useMemo(
    () => chemicals.filter((c) => needsBatch(c) && !c.batch_no),
    [chemicals, needsBatch],
  );

  /** Rows whose picked source has less *adjusted* availability than the
   *  computed total. A row with no source picked yet is treated as "short"
   *  so submission is blocked until the operator picks one. */
  const stockShortRows = useMemo(() => {
    const out: StockShortRow[] = [];
    chemicals.forEach((c, i) => {
      const need = qtyOf(c);
      if (!need || need <= 0) return;
      const source = c.source || "";
      const avail = rowAvailable(c);
      if (!source || avail < need) {
        out.push({ rowId: rowKey(c, i), name: c.item_name || c.item_code, source, avail, need });
      }
    });
    return out;
  }, [chemicals, rowAvailable, qtyOf, rowKey]);
  const stockShortById = useMemo(() => new Set(stockShortRows.map((s) => s.rowId)), [stockShortRows]);

  const reservedQty = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of chemicals) {
      if (!c.item_code || !c.source) continue;
      const q = qtyOf(c);
      if (q > 0) out[stockKey(c.source, c.item_code)] = (out[stockKey(c.source, c.item_code)] || 0) + q;
    }
    return out;
  }, [chemicals, qtyOf]);

  const fieldProblems = useMemo(
    () => (block ? planFieldProblems(value, areaHa, elsewhere) : []),
    [block, value, areaHa, elsewhere],
  );
  const problems = useMemo(() => fieldProblems.map((p) => p.text), [fieldProblems]);

  const setClassification = useCallback(
    (c: PlanValue["classification"]) =>
      update((p) =>
        p.classification === c
          ? p
          : { ...p, classification: c, ...(optsRef.current.placeKind === "block" ? { targets: [] } : {}) },
      ),
    [update],
  );

  const reset = useCallback(() => {
    ++loadSeq.current;
    setBomDetails(null);
    setBomError(null);
    setBomLoading(false);
    setBatchTouched(new Set());
    update(() => freshPlan(optsRef.current.defaultScheduledAt || todayAt("06:00")));
  }, [update]);

  return {
    placeKind,
    place,
    farm,
    areaHa,
    crop,
    value,
    stores: opts.stores ?? null,
    rateLimits: opts.rateLimits ?? {},
    reset,
    bom: value.bom,
    setBom,
    bomDetails,
    bomLoading,
    bomError,
    chemicals,
    setChemicals: setters.setChemicals,
    addChemical,
    makeChemRow,
    removeChemical,
    setRate,
    setBatch,
    setSource,
    setUom,
    rowKey,
    water: value.water,
    setWater: setters.setWater,
    waterPh: value.waterPh ?? "",
    setWaterPh: setters.setWaterPh,
    waterHardness: value.waterHardness ?? "",
    setWaterHardness: setters.setWaterHardness,
    area: value.area,
    setArea: setters.setArea,
    method: value.method || "",
    setMethod: setters.setMethod,
    scheduledAt: value.scheduledAt || defaultAt,
    setScheduledAt: setters.setScheduledAt,
    classification: value.classification,
    setClassification,
    reason: value.reason,
    setReason: setters.setReason,
    team: value.team,
    setTeam: setters.setTeam,
    members: value.members ?? [],
    setMembers: setters.setMembers,
    kit: value.kit,
    setKit: setters.setKit,
    targets: value.targets,
    setTargets: setters.setTargets,
    qtyOf,
    availability,
    rowAvailable,
    remainingFor,
    batchTone,
    needsBatch,
    batchMissingRows,
    stockShortRows,
    stockShortById,
    reservedQty,
    problems,
    fieldProblems,
    addOpen,
    setAddOpen,
    addNotice,
    setAddNotice,
  };
}
