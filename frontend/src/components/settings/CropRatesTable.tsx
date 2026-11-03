/**
 * Per-product rate table: one row per (crop, determinant). The determinant is
 * what the rate is measured against — Water (per 1000 L) or Hectarage (per
 * 10,000 m²). A product can carry both, and a row with no crop applies to
 * every crop.
 */

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilterSelect } from "@/components/FilterSelect";
import { RATE_BASES, basisLabel, type RateBasis } from "@/lib/spray-rates";
import type { CropRateRow } from "@/lib/settings-api";

const ALL_CROPS = "All crops";

export function CropRatesTable({
  rows,
  crops,
  onChange,
}: {
  rows: CropRateRow[];
  crops: string[];
  onChange: (next: CropRateRow[]) => void;
}) {
  const patch = (i: number, p: Partial<CropRateRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const seen = new Map<string, number>();
  const dupes = new Set<number>();
  rows.forEach((r, i) => {
    const k = `${r.crop}|${r.basis}`;
    if (seen.has(k)) {
      dupes.add(i);
      dupes.add(seen.get(k)!);
    } else seen.set(k, i);
  });

  return (
    <div className="space-y-2" data-testid="crop-rates-table">
      <div className="flex items-center justify-between">
        <span className="text-[0.7rem] uppercase tracking-wide font-semibold">
          Rates by crop and determinant
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1 rounded-full"
          onClick={() =>
            onChange([...rows, { crop: "", basis: "Water", lower_rate_limit: 0, upper_rate_limit: 0 }])
          }
        >
          <Plus className="h-3 w-3" />
          Add rate
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No crop rows — the default limits above apply (Water, per 1000 L) to every crop.
        </p>
      ) : (
        <div className="rounded-lg border divide-y">
          <div className="hidden md:grid grid-cols-[1.2fr_1.4fr_1fr_1fr_2rem] gap-2 px-3 py-1.5 text-[0.65rem] uppercase tracking-wide font-bold text-muted-foreground bg-muted/30">
            <span>Crop</span>
            <span>Determinant</span>
            <span>Lower</span>
            <span>Upper</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div
              key={i}
              data-testid="crop-rate-row"
              className="grid grid-cols-2 md:grid-cols-[1.2fr_1.4fr_1fr_1fr_2rem] gap-2 px-3 py-2 items-center"
            >
              <FilterSelect
                label="Crop"
                value={r.crop || ALL_CROPS}
                onChange={(v) => patch(i, { crop: v === ALL_CROPS ? "" : v })}
                options={[ALL_CROPS, ...crops]}
              />
              <FilterSelect
                label="Determinant"
                value={r.basis}
                onChange={(v) => patch(i, { basis: v as RateBasis })}
                options={RATE_BASES}
                format={(o) => basisLabel(o as RateBasis)}
              />
              <Input
                aria-label="Lower rate"
                type="number"
                step="any"
                min={0}
                value={r.lower_rate_limit || ""}
                onChange={(e) => patch(i, { lower_rate_limit: parseFloat(e.target.value) || 0 })}
                className="h-9 text-xs tabular-nums"
                placeholder="Lower"
              />
              <Input
                aria-label="Upper rate"
                type="number"
                step="any"
                min={0}
                value={r.upper_rate_limit || ""}
                onChange={(e) => patch(i, { upper_rate_limit: parseFloat(e.target.value) || 0 })}
                className="h-9 text-xs tabular-nums"
                placeholder="Upper"
              />
              <button
                type="button"
                aria-label="Remove rate"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="justify-self-end text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              {dupes.has(i) && (
                <p className="col-span-full text-[0.7rem] text-destructive">
                  Another row has the same crop and determinant — one row each.
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** True when two rows share crop + determinant. */
export function hasDuplicateRates(rows: CropRateRow[]): boolean {
  const s = new Set(rows.map((r) => `${r.crop}|${r.basis}`));
  return s.size !== rows.length;
}
