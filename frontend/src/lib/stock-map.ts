/** Shapes the Chemical Stock payload into what the treemap and its summary read. */
import type {
  CreatorStockOverview,
  StockBatch,
} from "@/lib/spray-plan-creator-api";
import { freshnessBand, nearestExpiryDays, type FreshnessBand } from "@/lib/stock-freshness";

export interface StockLocation {
  warehouse: string;
  farm: string;
  kind: "store" | "csu";
  qty: number;
  oldestAgeDays: number;
}

export interface StockItem {
  item_code: string;
  item_name: string;
  uom: string;
  /** Quantity in chemical stores (the stock the map draws). */
  qty: number;
  /** Stock value in chemical stores; 0 means no valuation on record. */
  value: number;
  csuQty: number;
  locations: StockLocation[];
  batches: StockBatch[];
  daysToExpiry: number | null;
  oldestAgeDays: number;
  band: FreshnessBand;
}

export function buildStockItems(data: CreatorStockOverview | null): StockItem[] {
  if (!data) return [];
  const byCode = new Map<string, StockItem>();
  const get = (code: string, name: string, uom: string): StockItem => {
    let it = byCode.get(code);
    if (!it) {
      const batches = data.batches?.[code] ?? [];
      it = {
        item_code: code,
        item_name: name || code,
        uom,
        qty: 0,
        value: 0,
        csuQty: 0,
        locations: [],
        batches,
        daysToExpiry: nearestExpiryDays(batches),
        oldestAgeDays: 0,
        band: "fresh",
      };
      byCode.set(code, it);
    }
    return it;
  };
  for (const w of data.chemical_stores) {
    for (const i of w.items) {
      const it = get(i.item_code, i.item_name, i.uom);
      it.qty += i.qty;
      it.value += i.value ?? 0;
      const age = i.oldest_age_days ?? 0;
      it.oldestAgeDays = Math.max(it.oldestAgeDays, age);
      it.locations.push({ warehouse: w.warehouse, farm: w.farm, kind: "store", qty: i.qty, oldestAgeDays: age });
    }
  }
  for (const w of data.csus) {
    for (const i of w.items) {
      const it = get(i.item_code, i.item_name, i.uom);
      it.csuQty += i.qty;
      it.locations.push({ warehouse: w.warehouse, farm: w.farm, kind: "csu", qty: i.qty, oldestAgeDays: i.oldest_age_days });
    }
  }
  const out = [...byCode.values()].filter((i) => i.qty > 0);
  for (const it of out) {
    it.band = freshnessBand({ daysToExpiry: it.daysToExpiry, oldestAgeDays: it.oldestAgeDays });
  }
  return out;
}
