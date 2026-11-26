/**
 * "Add chemical": search the chemical and fertilizer items, ranked by how well they
 * suit this plan (the spray check's product eligibility for the place and targets).
 * Products not registered for the targets are hidden unless "Show all" is on; other
 * rule-breakers are greyed. Picking one hands it to the plan form.
 *
 * Moved from `pages/ApplicationPlan.tsx`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { SearchInput } from "@/components/SearchInput";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SuggestedPill } from "@/components/spray-plan/SuggestedProducts";
import { searchChemicalItems, type ChemicalItem } from "@/lib/scouting-api";
import {
  eligibleProducts,
  pickerFilters,
  pickerState,
  type ProductEligibility,
} from "@/lib/spray-compliance-api";

export function AddChemicalDialog({
  open,
  onOpenChange,
  notice,
  onNoticeChange,
  place,
  targets,
  mixItems,
  when,
  suggestedCodes = [],
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** inline "already added" message */
  notice: string;
  onNoticeChange: (v: string) => void;
  /** the greenhouse or block the plan is for */
  place: string;
  targets: string[];
  mixItems: string[];
  when: string;
  suggestedCodes?: string[];
  onPick: (item: ChemicalItem) => void;
}) {
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState<ChemicalItem[]>([]);
  const [addEligRows, setAddEligRows] = useState<ProductEligibility[]>([]);
  const [addShowAll, setAddShowAll] = useState(false);
  const addTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add-chemical search debounce.
  useEffect(() => {
    if (!open) return;
    if (addTimerRef.current) clearTimeout(addTimerRef.current);
    addTimerRef.current = setTimeout(() => {
      searchChemicalItems(addQuery).then(setAddResults);
    }, 200);
    return () => {
      if (addTimerRef.current) clearTimeout(addTimerRef.current);
    };
  }, [addQuery, open]);

  // A pick closes the dialog; the next one starts from a blank search.
  useEffect(() => {
    if (!open) setAddQuery("");
  }, [open]);

  // Rank the search results by how well they suit this plan.
  useEffect(() => {
    if (!open || !place || !addResults.length) {
      setAddEligRows([]);
      return;
    }
    let cancelled = false;
    eligibleProducts({
      greenhouse: place,
      targets,
      items: mixItems,
      candidates: addResults.map((r) => r.item_code),
      when,
    })
      .then((rows) => !cancelled && setAddEligRows(rows))
      .catch(() => !cancelled && setAddEligRows([]));
    return () => {
      cancelled = true;
    };
  }, [open, place, targets, mixItems, addResults, when]);

  /** Search results in the server's suitability order; products not registered
   *  for the targets hidden unless "Show all" is on, other rule-breakers greyed
   *  (see `pickerState`). Unranked results keep their search order after the
   *  ranked ones. */
  const addElig = useMemo(
    () => Object.fromEntries(addEligRows.map((r) => [r.item, r])) as Record<string, ProductEligibility>,
    [addEligRows],
  );
  const addShown = useMemo(() => {
    const order = new Map(addEligRows.map((r, i) => [r.item, i]));
    const rank = (i: ChemicalItem) => order.get(i.item_code) ?? order.size;
    return [...addResults]
      .sort((a, b) => rank(a) - rank(b))
      .filter((it) => pickerState(addElig[it.item_code], addShowAll) !== "hidden");
  }, [addResults, addElig, addEligRows, addShowAll]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        // Clear the inline "already added" notice every time the modal
        // (re)opens or closes — stale messages from a previous attempt
        // would confuse the operator on the next add.
        onNoticeChange("");
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add chemical</DialogTitle>
          <DialogDescription>
            Search by item name or code. Restricted to chemical and fertilizer
            item groups so the source-warehouse picker stays valid.
          </DialogDescription>
        </DialogHeader>
        <SearchInput
          value={addQuery}
          onChange={(v) => {
            setAddQuery(v);
            if (notice) onNoticeChange("");
          }}
          placeholder="Search…"
          autoFocus
        />
        {notice && (
          <div className="rounded-md border border-amber-500/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-[1px] shrink-0" />
            <span>{notice}</span>
          </div>
        )}
        {(addShowAll || pickerFilters(addEligRows)) && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={addShowAll} onCheckedChange={(v) => setAddShowAll(v === true)} />
            Show all (including products not registered for the targets)
          </label>
        )}
        <div className="max-h-72 overflow-auto flex flex-col gap-1">
          {addShown.map((it) => {
            const e = addElig[it.item_code];
            const state = pickerState(e, addShowAll);
            const blocked = state === "blocked";
            return (
              <button
                key={it.item_code}
                type="button"
                disabled={blocked}
                onClick={() => onPick(it)}
                className={
                  "text-left px-3 py-2 rounded-md border bg-card transition-colors " +
                  (blocked
                    ? "opacity-60 cursor-not-allowed"
                    : state === "greyed"
                      ? "opacity-60 hover:opacity-100 hover:bg-muted"
                      : "hover:bg-muted") +
                  (suggestedCodes.includes(it.item_code) ? " border-primary/40 bg-primary/5" : "")
                }
              >
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  {it.item_name || it.item_code}
                  {suggestedCodes.includes(it.item_code) && <SuggestedPill />}
                </div>
                <div className="text-[0.65rem] text-muted-foreground font-mono">
                  {it.item_code} · {it.stock_uom || ""}
                  {it.is_fertilizer ? (
                    <span className="ml-1 text-[var(--sd-data-green)]">· Fertilizer Store</span>
                  ) : (
                    <span className="ml-1 text-[var(--sd-data-cyan)]">· Chemical Store</span>
                  )}
                </div>
                {e && !e.eligible && e.reasons[0] && (
                  <div className="text-[0.65rem] text-muted-foreground mt-0.5">{e.reasons[0]}</div>
                )}
              </button>
            );
          })}
          {!addResults.length && (
            <div className="text-xs text-muted-foreground py-3 text-center">Type to search.</div>
          )}
          {addResults.length > 0 && !addShown.length && (
            <div className="text-xs text-muted-foreground py-3 text-center">
              No result is registered for the targets. Turn on “Show all” to see them.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
