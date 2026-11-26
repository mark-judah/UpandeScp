/** Small pieces of the spray plan form shared by its parts (moved from pages/ApplicationPlan.tsx). */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ChemicalItem, RateLimit } from "@/lib/scouting-api";

/** Return a human message when ``rate`` (per 1000 L) falls outside the limits
 *  for ``itemCode``, or ``null`` when it's in range / no limits are configured.
 *  Pure so the same function can drive both the inline warning under the
 *  rate input and the pre-submit guard. Note: limits are per-1000 L, so the
 *  caller must pass the rate value, not the computed total qty. */
export function rateLimitError(
  itemCode: string | undefined,
  rate: number | undefined,
  limits: Record<string, RateLimit>,
): string | null {
  if (!itemCode || !rate || rate <= 0) return null;
  const lim = limits[itemCode];
  if (!lim) return null;
  if (lim.lower != null && rate < lim.lower) {
    return `Below lower limit of ${lim.lower} per 1000L.`;
  }
  if (lim.upper != null && rate > lim.upper) {
    return `Above upper limit of ${lim.upper} per 1000L.`;
  }
  return null;
}

/** A chemical staged in the "create tank mix" dialog. The dose is held as the
 *  raw input string so a half-typed "0." doesn't collapse to 0 mid-keystroke;
 *  it is parsed once, at submit. */
export type NewBomChem = ChemicalItem & { rate?: string };

/** Rows whose dose the server would reject, with the reason.
 *
 *  `create_bom.createBOM` requires `custom_application_rate > 0` on every row
 *  and fails the whole call on the first bad one. Checking here means the
 *  operator sees which row is wrong, inline, instead of a single
 *  "Rate must be > 0 for 'X' (row #1)" toast after a round-trip. */
export function newBomRateError(chem: NewBomChem): string | null {
  const raw = (chem.rate ?? "").trim();
  if (!raw) return "Dose required.";
  const rate = Number(raw);
  if (!Number.isFinite(rate)) return "Not a number.";
  if (rate <= 0) return "Must be greater than 0.";
  return null;
}

export function NumInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[0.65rem]">{label}</Label>
      <Input
        type="number"
        step="any"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs tabular-nums"
      />
    </div>
  );
}
