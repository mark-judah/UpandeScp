/**
 * The active ingredients of a chemical in the tank mix, each highlighted: name, MoA
 * group, concentration as recorded, and how much of it this plan uses (the server does
 * the maths: `spray_compliance.active_ingredients`). Nothing is guessed: a missing
 * concentration says so.
 */
import { FlaskConical } from "lucide-react";
import type { MixIngredient } from "@/lib/spray-compliance-api";

/** 54 -> "54 g", 1500 -> "1.5 kg", 2e12 -> "2.00 x 10^12 CFU". */
export function formatAmount(amount: number | null, unit: string | null): string {
  if (amount == null || !unit) return "";
  if (unit === "g") {
    if (amount >= 1000) return `${trim(amount / 1000)} kg`;
    if (amount > 0 && amount < 1) return `${trim(amount * 1000)} mg`;
    return `${trim(amount)} g`;
  }
  if (amount >= 1e6 || (amount > 0 && amount < 1)) {
    const [m, e] = amount.toExponential(2).split("e");
    return `${m} x 10^${Number(e)} ${unit}`;
  }
  return `${trim(amount)} ${unit}`;
}

function trim(n: number): string {
  return n >= 100 ? String(Math.round(n)) : String(Number(n.toPrecision(3)));
}

export function ActiveIngredients({ items }: { items: MixIngredient[] | undefined }) {
  if (!items?.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-1" data-testid="active-ingredients">
      {items.map((i, n) => (
        <div
          key={`${i.name}-${n}`}
          className="rounded-md bg-primary/10 px-2 py-1 text-[0.65rem]"
          data-testid="active-ingredient"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <FlaskConical className="h-3 w-3 shrink-0 text-primary" />
            <span className="font-medium text-foreground">{i.name}</span>
            {i.codes.map((c) => (
              <span key={c} className="rounded-full border border-primary/40 px-1.5 text-[0.6rem] text-primary">
                {c}
              </span>
            ))}
            <span className="text-muted-foreground">
              {i.concentration_label ?? "concentration not recorded"}
            </span>
          </div>
          {i.status === "ok" ? (
            <div className="mt-0.5 tabular-nums text-foreground">
              Uses <b>{formatAmount(i.amount, i.amount_unit)}</b>
              {i.per_ha != null && (
                <span className="text-muted-foreground">
                  {" "}
                  · {formatAmount(i.per_ha, i.amount_unit)} / ha
                </span>
              )}
            </div>
          ) : i.status === "no_quantity" ? (
            <div className="mt-0.5 text-muted-foreground">Enter a quantity to see the amount used.</div>
          ) : i.status === "unit_mismatch" ? (
            <div className="mt-0.5 text-muted-foreground">
              Amount not worked out: the quantity unit does not fit {i.concentration_unit}.
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
