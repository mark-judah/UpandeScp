/**
 * "Create a new tank mix": name, water pH and hardness, and the chemicals with their
 * dose per 1000 L. Stored as an ERPNext BOM through `create_bom.createBOM`; the caller
 * is told the new BOM's name so it can refresh its list and select it.
 *
 * Moved from `pages/ApplicationPlan.tsx` (legacy-parity create-BOM dialog).
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { SearchInput } from "@/components/SearchInput";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RowsSkeleton } from "@/components/Loading";
import {
  createBom,
  searchChemicalItems,
  type ChemicalItem,
  type RateLimit,
} from "@/lib/scouting-api";
import { useToast } from "@/components/Toast";
import { usePlanToasts } from "./usePlanToasts";
import { NumInput, newBomRateError, rateLimitError, type NewBomChem } from "./plan-form-utils";

export function NewTankMixDialog({
  open,
  onOpenChange,
  rateLimits,
  place,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rateLimits: Record<string, RateLimit>;
  /** the greenhouse or block the mix is made for (custom_greenhouse) */
  place?: string;
  /** after the server made it: refresh the list; the form then selects it */
  onCreated: (bomName: string) => Promise<void> | void;
}) {
  const { pushToast, pushError, dismissToast } = usePlanToasts(useToast());
  const [newBomItem, setNewBomItem] = useState<string>("");
  const [newBomPh, setNewBomPh] = useState<string>("7");
  const [newBomHardness, setNewBomHardness] = useState<string>("100");
  const [newBomChems, setNewBomChems] = useState<NewBomChem[]>([]);
  const [newBomSearch, setNewBomSearch] = useState<string>("");
  const [newBomCatalogLoaded, setNewBomCatalogLoaded] = useState(false);
  const [newBomSearchResults, setNewBomSearchResults] = useState<ChemicalItem[]>([]);
  const [creatingBom, setCreatingBom] = useState(false);
  const newBomSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // BOM-creation chemical search debounce.
  useEffect(() => {
    if (!open) return;
    if (newBomSearchTimerRef.current) clearTimeout(newBomSearchTimerRef.current);
    newBomSearchTimerRef.current = setTimeout(() => {
      searchChemicalItems(newBomSearch)
        .then(setNewBomSearchResults)
        .catch(() => setNewBomSearchResults([]))
        .finally(() => setNewBomCatalogLoaded(true));
    }, 200);
    return () => {
      if (newBomSearchTimerRef.current) clearTimeout(newBomSearchTimerRef.current);
    };
  }, [newBomSearch, open]);

  const addNewBomChem = (it: ChemicalItem) => {
    if (newBomChems.some((c) => c.item_code === it.item_code)) {
      pushToast("warn", `${it.item_name || it.item_code} is already in this tank mix.`);
      return;
    }
    // Seed the dose from the chemical's own configured lower limit. It is the
    // lowest rate the server will accept for this product, so it is both a safe
    // default and one the operator can only revise upward — never a number this
    // page invented.
    const seeded = rateLimits[it.item_code]?.lower ?? null;
    setNewBomChems((prev) => [...prev, { ...it, rate: seeded != null && seeded > 0 ? String(seeded) : "" }]);
    setNewBomSearch("");
  };
  const removeNewBomChem = (code: string) => setNewBomChems((prev) => prev.filter((c) => c.item_code !== code));
  const updateNewBomChemRate = (code: string, rate: string) =>
    setNewBomChems((prev) => prev.map((c) => (c.item_code === code ? { ...c, rate } : c)));

  const submitNewBom = async () => {
    if (!newBomItem.trim()) {
      pushToast("err", "Tank mix name is required.");
      return;
    }
    if (!newBomChems.length) {
      pushToast("err", "Add at least one chemical to the tank mix.");
      return;
    }
    // Every row needs a dose the server will accept. Report the first offender
    // by name — the server would too, but only after a round-trip.
    const bad = newBomChems.find((c) => newBomRateError(c));
    if (bad) {
      pushToast("err", `${bad.item_name || bad.item_code}: ${newBomRateError(bad)}`);
      return;
    }
    setCreatingBom(true);
    const loaderId = pushToast("loading", "Creating tank mix…", 0);
    const done = () => dismissToast(loaderId);
    try {
      const r = await createBom({
        item: newBomItem.trim(),
        custom_water_ph: parseFloat(newBomPh) || 0,
        custom_water_hardness: parseFloat(newBomHardness) || 0,
        items: newBomChems.map((c) => ({
          item_code: c.item_code,
          item_name: c.item_name,
          // The BOM is defined per 1000 L, so the dose IS the quantity. `qty`
          // was hardcoded to 1 here while the rate was never sent at all.
          qty: Number(c.rate),
          custom_application_rate: Number(c.rate),
          stock_uom: c.stock_uom,
        })),
        custom_greenhouse: place || undefined,
      });
      done();
      if (r.status === "success" && r.bom_name) {
        pushToast("ok", `Created tank mix ${r.bom_name}.`);
        // Refresh the list so the new BOM appears in the picker; the form then
        // selects it.
        await onCreated(r.bom_name);
        onOpenChange(false);
        setNewBomItem("");
        setNewBomChems([]);
        setNewBomSearch("");
      } else {
        pushError(r.message, "The tank mix could not be created.");
      }
    } catch (e: unknown) {
      done();
      pushError(e, "The tank mix could not be created.");
    } finally {
      setCreatingBom(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create a new tank mix</DialogTitle>
          <DialogDescription>
            The mix is created here and selected straight away. It is stored as
            an ERPNext bill of materials, which is what you will see in Desk.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label>Tank Mix Name</Label>
            <Input
              value={newBomItem}
              onChange={(e) => setNewBomItem(e.target.value)}
              placeholder="e.g. Botrytis Mix · Greenhouse 12"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumInput label="Water pH" value={newBomPh} onChange={setNewBomPh} />
            <NumInput label="Water Hardness" value={newBomHardness} onChange={setNewBomHardness} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Add chemical</Label>
            <SearchInput value={newBomSearch} onChange={setNewBomSearch} placeholder="Search…" />
            {/* Listed as soon as the dialog opens, not only once something is
              *  typed: the search runs with a blank query too, and an empty
              *  panel read as "there are no chemicals" rather than "start
              *  typing". */}
            {newBomSearchResults.length > 0 ? (
              <div className="rounded-md border bg-card max-h-40 overflow-auto">
                {newBomSearchResults.map((it) => (
                  <button
                    key={it.item_code}
                    type="button"
                    onClick={() => addNewBomChem(it)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted border-b last:border-b-0"
                  >
                    <span className="font-medium">{it.item_name || it.item_code}</span>
                    <span className="ml-2 text-[0.65rem] text-muted-foreground font-mono">{it.item_code}</span>
                  </button>
                ))}
              </div>
            ) : newBomSearch ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">Nothing matches "{newBomSearch}".</p>
            ) : !newBomCatalogLoaded ? (
              // The catalogue's first page has not landed: its list box, pulsing.
              <div className="rounded-md border bg-card max-h-40 overflow-hidden" aria-busy="true">
                <RowsSkeleton rows={4} className="gap-0" />
              </div>
            ) : (
              <p className="px-1 py-2 text-xs text-muted-foreground">No chemicals found.</p>
            )}
          </div>
          {newBomChems.length > 0 && (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Chemical</TableHead>
                    <TableHead className="w-32">Dose / 1000 L</TableHead>
                    <TableHead>UoM</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {newBomChems.map((c) => {
                    const rateErr = newBomRateError(c);
                    const limit = rateLimits[c.item_code];
                    const outOfRange = rateLimitError(c.item_code, Number(c.rate), rateLimits);
                    return (
                      <TableRow key={c.item_code}>
                        <TableCell className="text-xs">
                          <div className="font-medium">{c.item_name || c.item_code}</div>
                          <div className="text-[0.65rem] text-muted-foreground font-mono">{c.item_code}</div>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min="0"
                            step="any"
                            inputMode="decimal"
                            className="h-7 text-xs"
                            aria-label={`Dose per 1000 L for ${c.item_name || c.item_code}`}
                            aria-invalid={rateErr ? true : undefined}
                            value={c.rate ?? ""}
                            placeholder="0.00"
                            onChange={(e) => updateNewBomChemRate(c.item_code, e.target.value)}
                          />
                          {rateErr ? (
                            <p className="mt-0.5 text-[0.65rem] text-destructive">{rateErr}</p>
                          ) : outOfRange ? (
                            <p className="mt-0.5 text-[0.65rem] text-amber-600">{outOfRange}</p>
                          ) : limit?.lower != null || limit?.upper != null ? (
                            <p className="mt-0.5 text-[0.65rem] text-muted-foreground">
                              {limit.lower ?? "—"} – {limit.upper ?? "—"}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs">{c.stock_uom || ""}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground"
                            aria-label={`Remove ${c.item_name || c.item_code}`}
                            onClick={() => removeNewBomChem(c.item_code)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={creatingBom}>
              Cancel
            </Button>
            <Button
              onClick={submitNewBom}
              disabled={creatingBom || !newBomChems.length || newBomChems.some((c) => newBomRateError(c))}
            >
              {creatingBom ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Create tank mix
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
