import type { ChemicalItem } from "@/lib/scouting-api";
import type { PickerState } from "@/lib/spray-compliance-api";
import { SuggestedPill } from "@/components/spray-plan/SuggestedProducts";

/** One row of the Add-chemical search list. "inactive" = not registered for the
 *  selected targets and "Show all" is off: visible, muted, aria-disabled, and a
 *  click only asks the user to tick the checkbox. */
export function ChemicalPickerRow({
  item, state, reason, targetLabel, suggested, onAdd, onInactive,
}: {
  item: ChemicalItem;
  state: PickerState;
  reason?: string;
  targetLabel?: string;
  suggested?: boolean;
  onAdd: () => void;
  onInactive?: () => void;
}) {
  const inactive = state === "inactive";
  const blocked = state === "blocked";
  const muted = inactive || blocked || state === "greyed";
  return (
    <button
      type="button"
      disabled={blocked}
      aria-disabled={inactive || blocked}
      data-state={state}
      onClick={() => (inactive ? onInactive?.() : onAdd())}
      className={
        "text-left px-3 py-2 rounded-md border bg-card transition-colors " +
        (blocked || inactive
          ? "opacity-60 cursor-not-allowed"
          : state === "greyed"
            ? "opacity-60 hover:opacity-100 hover:bg-muted"
            : "hover:bg-muted") +
        (suggested && !muted ? " border-primary/40 bg-primary/5" : "")
      }
    >
      <div className={"flex items-center gap-1.5 text-xs font-medium " + (inactive ? "text-muted-foreground" : "")}>
        {item.item_name || item.item_code}
        {suggested && !inactive && <SuggestedPill />}
      </div>
      <div className="text-[0.65rem] text-muted-foreground font-mono">
        {item.item_code} · {item.stock_uom || ""}
        {item.is_fertilizer ? (
          <span className="ml-1 text-[var(--sd-data-green)]">· Fertilizer Store</span>
        ) : (
          <span className="ml-1 text-[var(--sd-data-cyan)]">· Chemical Store</span>
        )}
      </div>
      {inactive ? (
        <div className="text-[0.65rem] text-muted-foreground mt-0.5">
          {targetLabel ? `Not for ${targetLabel}` : "Not for the selected target"}
        </div>
      ) : (
        reason && <div className="text-[0.65rem] text-muted-foreground mt-0.5">{reason}</div>
      )}
    </button>
  );
}
