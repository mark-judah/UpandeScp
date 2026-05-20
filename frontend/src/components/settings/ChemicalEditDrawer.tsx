/**
 * Chemical edit drawer — full editor for one Item's spray-plan custom
 * fields. Covers rate range, IRAC / FRAC / GHS codes (multi-select chip
 * pickers), active ingredients (free-text chip list), and the per-chemical
 * target list (pests + diseases).
 */

import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Save, Search, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  saveChemical,
  type ChemicalRow,
  type ChemicalTarget,
  type ChemicalType,
  type CodesResponse,
  type TargetsResponse,
  type ToxicityClass,
} from "@/lib/settings-api";
import { FrappeError } from "@/lib/frappe";

interface Props {
  open: boolean;
  onClose: () => void;
  chemical: ChemicalRow | null;
  codes: CodesResponse | null;
  targets: TargetsResponse | null;
  onSaved: (updated: ChemicalRow) => void;
}

type DraftTarget = ChemicalTarget & { _kind: "pest" | "disease" };

function buildDraftTargets(rows: ChemicalTarget[]): DraftTarget[] {
  return rows
    .map((r) => ({
      ...r,
      _kind: (r.pest ? "pest" : "disease") as "pest" | "disease",
    }))
    .filter((r) => r.pest || r.disease);
}

export function ChemicalEditDrawer({
  open,
  onClose,
  chemical,
  codes,
  targets,
  onSaved,
}: Props) {
  const [enabled, setEnabled] = useState(true);
  const [type, setType] = useState<ChemicalType>("");
  const [toxicity, setToxicity] = useState<ToxicityClass>("");
  const [reentry, setReentry] = useState<string>("");
  const [lower, setLower] = useState<string>("");
  const [upper, setUpper] = useState<string>("");
  const [iracMoa, setIracMoa] = useState("");
  const [fracMoa, setFracMoa] = useState("");
  const [ghsDescription, setGhsDescription] = useState("");
  const [irac, setIrac] = useState<string[]>([]);
  const [frac, setFrac] = useState<string[]>([]);
  const [ghs, setGhs] = useState<string[]>([]);
  const [actives, setActives] = useState<string[]>([]);
  const [newActive, setNewActive] = useState("");
  const [drafts, setDrafts] = useState<DraftTarget[]>([]);
  const [targetQuery, setTargetQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate state from the picked chemical.
  useEffect(() => {
    if (!chemical) return;
    setEnabled(chemical.enabled);
    setType((chemical.custom_type as ChemicalType) || "");
    setToxicity((chemical.custom_toxicity as ToxicityClass) || "");
    setReentry(
      chemical.custom_reentry_interval_hrs != null
        ? String(chemical.custom_reentry_interval_hrs)
        : "",
    );
    setLower(
      chemical.custom_lower_rate_limit != null
        ? String(chemical.custom_lower_rate_limit)
        : "",
    );
    setUpper(
      chemical.custom_upper_rate_limit != null
        ? String(chemical.custom_upper_rate_limit)
        : "",
    );
    setIracMoa(chemical.custom_irac_moa || "");
    setFracMoa(chemical.custom_frac_moa || "");
    setGhsDescription(chemical.custom_ghs_description || "");
    setIrac(chemical.irac);
    setFrac(chemical.frac);
    setGhs(chemical.ghs);
    setActives(chemical.active_ingredients);
    setDrafts(buildDraftTargets(chemical.targets));
    setNewActive("");
    setTargetQuery("");
    setError(null);
  }, [chemical]);

  const toggleCode = (
    list: string[],
    setList: (next: string[]) => void,
    code: string,
  ) => setList(list.includes(code) ? list.filter((c) => c !== code) : [...list, code]);

  const addActive = () => {
    const v = newActive.trim();
    if (!v) return;
    if (actives.includes(v)) return;
    setActives([...actives, v]);
    setNewActive("");
  };
  const removeActive = (v: string) =>
    setActives(actives.filter((a) => a !== v));

  const addTarget = (kind: "pest" | "disease", name: string) => {
    if (drafts.some((d) => (kind === "pest" ? d.pest === name : d.disease === name)))
      return;
    setDrafts((d) => [
      ...d,
      kind === "pest"
        ? { pest: name, disease: "", _kind: "pest" }
        : { pest: "", disease: name, _kind: "disease" },
    ]);
  };
  const removeTarget = (idx: number) =>
    setDrafts((d) => d.filter((_, i) => i !== idx));

  // Filter target catalog for the picker — exclude what's already added.
  const filteredTargets = useMemo(() => {
    if (!targets) return { pests: [], diseases: [] };
    const q = targetQuery.trim().toLowerCase();
    const matches = (s: string) => !q || s.toLowerCase().includes(q);
    const pickedPests = new Set(drafts.filter((d) => d.pest).map((d) => d.pest));
    const pickedDiseases = new Set(drafts.filter((d) => d.disease).map((d) => d.disease));
    return {
      pests: targets.pests
        .filter((p) => !pickedPests.has(p.name))
        .filter((p) => matches(p.common_name || p.name) || matches(p.name))
        .slice(0, 30),
      diseases: targets.diseases
        .filter((d) => !pickedDiseases.has(d.name))
        .filter((d) => matches(d.common_name || d.name) || matches(d.name))
        .slice(0, 30),
    };
  }, [targets, drafts, targetQuery]);

  const handleSave = async () => {
    if (!chemical) return;
    setSaving(true);
    setError(null);
    try {
      const reentryNum = parseFloat(reentry) || 0;
      const lowerNum = parseFloat(lower) || 0;
      const upperNum = parseFloat(upper) || 0;

      // Only send chemical-only keys when we actually showed the editor
      // for them. For fertilizers, omitting these leaves the underlying
      // fields untouched server-side rather than wiping them.
      const chemicalsOnlyPayload = isFertilizer
        ? {}
        : {
            type,
            irac,
            frac,
            irac_moa: iracMoa,
            frac_moa: fracMoa,
            targets: drafts.map(({ pest, disease }) => ({ pest, disease })),
          };

      await saveChemical(chemical.item_code, {
        enabled,
        toxicity,
        reentry_interval_hrs: reentryNum,
        lower_rate_limit: lowerNum,
        upper_rate_limit: upperNum,
        ghs_description: ghsDescription,
        ghs,
        active_ingredients: actives,
        ...chemicalsOnlyPayload,
      });
      onSaved({
        ...chemical,
        enabled,
        disabled: enabled ? 0 : 1,
        custom_toxicity: toxicity || null,
        custom_reentry_interval_hrs: reentryNum,
        custom_lower_rate_limit: lowerNum,
        custom_upper_rate_limit: upperNum,
        custom_ghs_description: ghsDescription,
        ghs,
        active_ingredients: actives,
        // Chemical-only fields stay unchanged when editing a fertilizer.
        ...(isFertilizer
          ? {}
          : {
              custom_type: type || null,
              custom_irac_moa: iracMoa,
              custom_frac_moa: fracMoa,
              irac,
              frac,
              targets: drafts.map(({ pest, disease }) => ({ pest, disease })),
            }),
      });
      onClose();
    } catch (e) {
      setError(e instanceof FrappeError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!chemical) return null;

  const isFertilizer = chemical.kind === "fertilizer";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-col gap-1">
            <span className="inline-flex items-center gap-2 text-base">
              <span
                className={
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[0.6rem] font-bold uppercase tracking-wider " +
                  (isFertilizer
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
                    : "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-200")
                }
              >
                {isFertilizer ? "Fertilizer" : "Chemical"}
              </span>
              {chemical.item_name || chemical.item_code}
            </span>
            <span className="text-[0.7rem] font-mono text-muted-foreground tabular-nums">
              #{chemical.item_code} · {chemical.item_group} · {chemical.stock_uom}
            </span>
          </DialogTitle>
          <DialogDescription>
            {isFertilizer
              ? "Edit per-fertilizer metadata — enable flag, rate range, GHS / hazard, and active ingredients. Fertilizers feed plants rather than treating pests, so no target picker."
              : "Edit per-chemical metadata used by the spray plan creator — rate range, resistance codes, and the list of pests / diseases this chemical can treat."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 pt-2">
          {/* Identity: enabled, chemical type, toxicity, re-entry */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
            <div className="flex items-center gap-2 px-3 py-2 rounded-md border bg-card h-9">
              <Checkbox
                id="enabled"
                checked={enabled}
                onCheckedChange={(v) => setEnabled(!!v)}
              />
              <Label htmlFor="enabled" className="text-xs cursor-pointer">
                Enabled
              </Label>
            </div>
            {!isFertilizer && (
              <div className="flex flex-col gap-1">
                <Label className="text-[0.7rem]">Chemical class</Label>
                <Select
                  value={type || "__none"}
                  onValueChange={(v) => setType(v === "__none" ? "" : (v as ChemicalType))}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="Unclassified" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Unclassified</SelectItem>
                    <SelectItem value="Insecticide">Insecticide</SelectItem>
                    <SelectItem value="Fungicide">Fungicide</SelectItem>
                    <SelectItem value="Adjuvant">Adjuvant</SelectItem>
                    <SelectItem value="pH Buffer">pH Buffer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label className="text-[0.7rem]">Hazard class</Label>
              <Select
                value={toxicity || "__none"}
                onValueChange={(v) => setToxicity(v === "__none" ? "" : (v as ToxicityClass))}
              >
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Not set</SelectItem>
                  <SelectItem value="I">I · Extremely hazardous</SelectItem>
                  <SelectItem value="II">II · Highly hazardous</SelectItem>
                  <SelectItem value="III">III · Slightly hazardous</SelectItem>
                  <SelectItem value="IV">IV · Unlikely to cause harm</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[0.7rem]">Re-entry interval (hrs)</Label>
              <Input
                type="number"
                step="any"
                min={0}
                value={reentry}
                onChange={(e) => setReentry(e.target.value)}
                className="h-9 text-xs tabular-nums"
                placeholder="0"
              />
            </div>
          </section>

          {/* Rate range */}
          <section className="grid grid-cols-2 gap-3">
            <RateField
              label="Lower rate limit (per 1000L)"
              value={lower}
              onChange={setLower}
            />
            <RateField
              label="Upper rate limit (per 1000L)"
              value={upper}
              onChange={setUpper}
            />
          </section>

          {/* Resistance codes — chemicals only. Fertilizers don't carry
              insecticide / fungicide resistance classifications. */}
          {!isFertilizer && (
            <>
              <section className="space-y-3">
                <Label className="text-[0.7rem] uppercase tracking-wide font-semibold">
                  IRAC codes
                </Label>
                <CodeChipPicker
                  options={codes?.irac.map((c) => c.name) || []}
                  selected={irac}
                  onToggle={(c) => toggleCode(irac, setIrac, c)}
                  empty="No IRAC codes configured."
                />
                <textarea
                  value={iracMoa}
                  onChange={(e) => setIracMoa(e.target.value)}
                  rows={2}
                  placeholder="Mode-of-action notes (optional)…"
                  className="w-full rounded-md border bg-background px-3 py-2 text-xs"
                />
              </section>

              <section className="space-y-3">
                <Label className="text-[0.7rem] uppercase tracking-wide font-semibold">
                  FRAC codes
                </Label>
                <CodeChipPicker
                  options={codes?.frac.map((c) => c.name) || []}
                  selected={frac}
                  onToggle={(c) => toggleCode(frac, setFrac, c)}
                  empty="No FRAC codes configured."
                />
                <textarea
                  value={fracMoa}
                  onChange={(e) => setFracMoa(e.target.value)}
                  rows={2}
                  placeholder="Mode-of-action notes (optional)…"
                  className="w-full rounded-md border bg-background px-3 py-2 text-xs"
                />
              </section>
            </>
          )}

          <section className="space-y-3">
            <Label className="text-[0.7rem] uppercase tracking-wide font-semibold">
              GHS codes
            </Label>
            <CodeChipPicker
              options={codes?.ghs.map((c) => c.name) || []}
              selected={ghs}
              onToggle={(c) => toggleCode(ghs, setGhs, c)}
              empty="No GHS codes configured."
            />
            <Input
              value={ghsDescription}
              onChange={(e) => setGhsDescription(e.target.value)}
              placeholder="GHS description (free text)…"
              className="h-9 text-xs"
            />
          </section>

          {/* Active ingredients */}
          <section className="space-y-2">
            <Label className="text-[0.7rem] uppercase tracking-wide font-semibold">
              Active ingredients
            </Label>
            <div className="flex gap-2">
              <Input
                value={newActive}
                onChange={(e) => setNewActive(e.target.value)}
                placeholder="Add an active ingredient…"
                className="h-9 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addActive();
                  }
                }}
              />
              <Button
                type="button"
                onClick={addActive}
                disabled={!newActive.trim()}
                size="sm"
                className="h-9 gap-1"
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
            {actives.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No active ingredients listed.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {actives.map((a) => (
                  <li
                    key={a}
                    className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 text-emerald-900 px-2.5 py-1 text-xs font-medium dark:bg-emerald-950 dark:text-emerald-200"
                  >
                    {a}
                    <button
                      type="button"
                      onClick={() => removeActive(a)}
                      className="hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Targets — chemicals only. Fertilizers don't "treat" pests
              or diseases; they feed plants. */}
          {!isFertilizer && (
          <section className="space-y-3">
            <Label className="text-[0.7rem] uppercase tracking-wide font-semibold">
              Treats (pests + diseases)
            </Label>
            <div className="rounded-lg border overflow-hidden">
              <div className="relative border-b bg-muted/40">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  value={targetQuery}
                  onChange={(e) => setTargetQuery(e.target.value)}
                  placeholder="Search pests + diseases…"
                  className="pl-8 border-0 bg-transparent rounded-none h-9 text-xs"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-border max-h-56 overflow-y-auto">
                <TargetColumn
                  title="Pests"
                  items={filteredTargets.pests}
                  onAdd={(n) => addTarget("pest", n)}
                  fallback={!targets?.pests.length}
                />
                <TargetColumn
                  title="Diseases"
                  items={filteredTargets.diseases}
                  onAdd={(n) => addTarget("disease", n)}
                  fallback={!targets?.diseases.length}
                />
              </div>
            </div>

            {drafts.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No targets — this chemical isn't yet associated with any pest
                or disease. Pick from the catalog above.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {drafts.map((d, i) => (
                  <li
                    key={`${d._kind}-${d.pest || d.disease}-${i}`}
                    className={
                      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium border " +
                      (d._kind === "pest"
                        ? "bg-rose-50 text-rose-900 border-rose-200 dark:bg-rose-950 dark:text-rose-100 dark:border-rose-900"
                        : "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-900")
                    }
                  >
                    <span className="text-[0.6rem] uppercase tracking-wide font-bold opacity-70">
                      {d._kind === "pest" ? "Pest" : "Dis."}
                    </span>
                    {d.pest || d.disease}
                    <button
                      type="button"
                      onClick={() => removeTarget(i)}
                      className="hover:text-destructive transition-colors"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          )}

          <div className="flex items-center justify-end gap-3 pt-2 border-t">
            {error && (
              <span className="text-xs text-destructive max-w-sm text-right">
                {error}
              </span>
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save changes
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RateField({
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
      <Label className="text-[0.7rem]">{label}</Label>
      <Input
        type="number"
        step="any"
        min={0}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 text-xs tabular-nums"
      />
    </div>
  );
}

function CodeChipPicker({
  options,
  selected,
  onToggle,
  empty,
}: {
  options: string[];
  selected: string[];
  onToggle: (code: string) => void;
  empty: string;
}) {
  if (!options.length) {
    return <p className="text-xs text-muted-foreground italic">{empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto rounded-md border bg-card p-2">
      {options.map((c) => {
        const on = selected.includes(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => onToggle(c)}
            className={
              "px-2.5 py-1 rounded-full text-[0.7rem] font-medium border transition-colors " +
              (on
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-muted hover:bg-muted/70")
            }
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function TargetColumn({
  title,
  items,
  onAdd,
  fallback,
}: {
  title: string;
  items: { name: string; common_name?: string | null }[];
  onAdd: (name: string) => void;
  fallback: boolean;
}) {
  return (
    <div className="flex flex-col">
      <div className="px-3 py-1.5 text-[0.65rem] uppercase tracking-wide font-bold text-muted-foreground bg-muted/30 border-b">
        {title}
      </div>
      {fallback ? (
        <div className="px-3 py-4 text-xs text-muted-foreground italic">
          Catalog is empty — add in Frappe Desk.
        </div>
      ) : items.length === 0 ? (
        <div className="px-3 py-4 text-xs text-muted-foreground italic">
          No matches.
        </div>
      ) : (
        <ul>
          {items.map((it) => (
            <li key={it.name}>
              <button
                type="button"
                onClick={() => onAdd(it.name)}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center justify-between gap-2 border-b last:border-b-0"
              >
                <span className="truncate">
                  {it.common_name || it.name}
                  {it.common_name && it.common_name !== it.name && (
                    <span className="ml-1.5 text-[0.6rem] text-muted-foreground font-mono">
                      {it.name}
                    </span>
                  )}
                </span>
                <Plus className="h-3 w-3 text-primary shrink-0" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
