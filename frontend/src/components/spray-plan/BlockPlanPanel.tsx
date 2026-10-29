/**
 * The right-hand planning panel of the open-field spray plan: one section per
 * selected block, each planned separately — Preventive or Curative, then the team,
 * then the tank mix (BOM) — with the block's own scouted findings and suggested
 * chemicals. A jump dropdown lists every selected block. When more than
 * COLLAPSE_ABOVE blocks are selected the sections collapse to a header (a dropdown
 * per block) and one is open at a time, so the planner works down the list.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronsUpDown, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BomPicker } from "@/components/BomPicker";
import { CropChip } from "@/components/CropChip";
import { SuggestedProductsCard } from "@/components/spray-plan/SuggestedProducts";
import { fetchBomDetails } from "@/lib/scouting-api";
import type { CreatorBootstrap } from "@/lib/spray-plan-creator-api";
import type { BlockFindings } from "@/lib/open-field-api";
import {
  chemicalQty, effectiveArea, planProblems, shouldCollapse,
  type BlockPlan, type OpenFieldBlock,
} from "@/lib/open-field";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/errors";

interface PanelProps {
  blocks: OpenFieldBlock[];
  plans: Record<string, BlockPlan>;
  onPlanChange: (block: string, plan: BlockPlan) => void;
  /** planning data of the route crop; used for blocks with no crop of their own */
  boot: CreatorBootstrap | null;
  /** planning data per crop (target catalogs, tank mixes, teams, stores): a block with a
   *  crop uses its own crop's entry, null while that is loading, never the route crop's */
  bootByCrop?: Record<string, CreatorBootstrap | null>;
  findings: Record<string, BlockFindings>;
  /** the plan's spray date-time, passed to the suggestions */
  when: string;
}

export function BlockPlanPanel({ blocks, plans, onPlanChange, boot, bootByCrop, findings, when }: PanelProps) {
  const collapsed = shouldCollapse(blocks.length);
  const [open, setOpen] = useState<string>(blocks[0]?.name ?? "");
  const refs = useRef<Record<string, HTMLElement | null>>({});

  // Keep the open block valid as blocks are picked and dropped.
  useEffect(() => {
    if (!blocks.some((b) => b.name === open)) setOpen(blocks[0]?.name ?? "");
  }, [blocks, open]);

  const ready = (b: OpenFieldBlock) => planProblems(plans[b.name], effectiveArea(b, plans[b.name])).length === 0;
  const done = blocks.filter(ready).length;

  const jump = (name: string) => {
    setOpen(name);
    // after the section opens, bring it into view
    setTimeout(() => refs.current[name]?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  };
  const next = (name: string) => {
    const i = blocks.findIndex((b) => b.name === name);
    if (blocks[i + 1]) jump(blocks[i + 1].name);
  };

  if (!blocks.length) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        Select one or more blocks to plan them. Each block gets its own spray programme.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="block-plan-panel">
      <div className="flex items-center justify-between gap-2">
        <JumpDropdown blocks={blocks} ready={ready} onPick={jump} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {done} of {blocks.length} ready
        </span>
      </div>
      {blocks.map((b) => {
        const isOpen = !collapsed || open === b.name;
        const plan = plans[b.name];
        const problems = planProblems(plan, effectiveArea(b, plan));
        return (
          <section
            key={b.name}
            data-testid="block-section"
            data-open={isOpen || undefined}
            ref={(el) => { refs.current[b.name] = el; }}
            className="rounded-xl border bg-card"
          >
            <header
              className={cn("flex items-center gap-2 px-4 py-3", collapsed && "cursor-pointer")}
              onClick={collapsed ? () => jump(b.name) : undefined}
            >
              {collapsed && (
                <button
                  type="button"
                  aria-label={b.label}
                  aria-expanded={isOpen}
                  className="flex items-center"
                  onClick={(e) => { e.stopPropagation(); jump(b.name); }}
                >
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
              )}
              <span className="font-semibold">{b.label}</span>
              <CropChip crop={b.crop_label} />
              <span className="flex-1" />
              {problems.length === 0 ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                  <Check className="h-3.5 w-3.5" /> Ready
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Needs {problems[0]}</span>
              )}
            </header>
            {isOpen && (
              <BlockSection
                block={b}
                plan={plan}
                onChange={(p) => onPlanChange(b.name, p)}
                boot={bootByCrop && b.crop ? bootByCrop[b.crop] ?? null : boot}
                findings={findings[b.name]}
                when={when}
                onNext={collapsed && blocks[blocks.indexOf(b) + 1] ? () => next(b.name) : undefined}
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

function JumpDropdown({
  blocks, ready, onPick,
}: { blocks: OpenFieldBlock[]; ready: (b: OpenFieldBlock) => boolean; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Jump to block"
          className="inline-flex h-9 items-center gap-2 rounded-full bg-card px-4 text-xs font-medium shadow-[var(--sd-shadow-1)] hover:shadow-[var(--sd-shadow-2)]"
        >
          Jump to block <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        <div role="listbox" aria-label="Selected blocks" className="max-h-72 overflow-y-auto">
          {blocks.map((b) => (
            <button
              key={b.name}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => { onPick(b.name); setOpen(false); }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <span className="flex-1 truncate">{b.label}</span>
              <CropChip crop={b.crop_label} />
              {ready(b) && <Check className="h-3.5 w-3.5 text-emerald-600" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BlockSection({
  block, plan, onChange, boot, findings, when, onNext,
}: {
  block: OpenFieldBlock;
  plan: BlockPlan;
  onChange: (p: BlockPlan) => void;
  boot: CreatorBootstrap | null;
  findings?: BlockFindings;
  when: string;
  onNext?: () => void;
}) {
  const planRef = useRef(plan);
  planRef.current = plan;
  const [bomBusy, setBomBusy] = useState(false);
  const [bomError, setBomError] = useState<string | null>(null);

  const store = (block.farm && boot?.farm_stores?.[block.farm]?.chemical_store) || "";
  const teams = useMemo(
    () => (boot?.spray_teams || []).filter((t) => !block.farm || !t.custom_farm || t.custom_farm === block.farm),
    [boot, block.farm],
  );
  const kits = useMemo(
    () => (boot?.kits || []).filter((k) => !block.farm || !k.custom_farm || k.custom_farm === block.farm),
    [boot, block.farm],
  );
  const boms = useMemo(
    () => (boot?.tank_mixes || []).filter((m) => !block.farm || !m.custom_farm || m.custom_farm === block.farm),
    [boot, block.farm],
  );

  const area = effectiveArea(block, plan);
  const set = (patch: Partial<BlockPlan>) => onChange({ ...planRef.current, ...patch });

  // Curative targets are what was scouted on the block; preventive may name any
  // registered pest or disease of the crop.
  const targetOptions =
    plan.classification === "Preventive"
      ? [...(boot?.pest_catalog || []).map((p) => p.name), ...(boot?.disease_catalog || []).map((d) => d.name)]
      : findings?.targets || [];

  const pickBom = async (bom: string) => {
    set({ bom, chemicals: [] });
    if (!bom) return;
    setBomBusy(true);
    setBomError(null);
    try {
      const d = await fetchBomDetails(bom, block.name);
      if (!d) return;
      const chemicals = d.chemicals.map((c) => ({
        item_code: c.item_code,
        item_name: c.item_name,
        stock_uom: c.stock_uom,
        rate: Number(c.stock_qty) || 0,
        source:
          (c.is_fertilizer ? boot?.farm_stores?.[block.farm || ""]?.fertilizer_store : store) ||
          (c.is_fertilizer ? d.fertilizer_warehouses?.[0] : d.chemical_warehouses?.[0]) ||
          "",
      }));
      onChange({ ...planRef.current, bom, chemicals });
    } catch (e) {
      setBomError(errorText(e, "Could not load this tank mix's chemicals."));
    } finally {
      setBomBusy(false);
    }
  };

  if (!boot) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4" aria-busy="true" data-skeleton="plan">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 pb-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Area (ha)</Label>
          <Input
            type="number" step="any" min={0} className="h-9 w-28 tabular-nums"
            value={plan.area}
            placeholder={block.area_ha > 0 ? block.area_ha.toFixed(2) : "Enter area"}
            onChange={(e) => set({ area: e.target.value })}
          />
        </div>
        <div className="pb-2 text-xs text-muted-foreground tabular-nums">
          Water {(area * 1000).toFixed(0)} L
          {block.cost_center ? ` · cost centre ${block.cost_center}` : " · cost centre derived on save"}
        </div>
      </div>

      <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs">
        <div className="mb-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground">Scouted here, last 30 days</div>
        {findings && (findings.pests.length || findings.diseases.length) ? (
          <div className="flex flex-wrap gap-1.5">
            {[...findings.pests, ...findings.diseases].map((f) => (
              <span key={f.name} className="rounded-full bg-background px-2 py-0.5">
                {f.name} <span className="tabular-nums text-muted-foreground">{f.count}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">Nothing scouted on this block lately.</span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">Classification</Label>
        <div className="flex gap-2">
          {(["Curative", "Preventive"] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={plan.classification === c}
              onClick={() => set({ classification: c, targets: [] })}
              className={cn(
                "rounded-full border px-4 py-1.5 text-xs transition-colors",
                plan.classification === c ? "border-primary bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {plan.classification === "Preventive" && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Preventive reason <span className="text-muted-foreground">(at least 20 characters)</span></Label>
          <textarea
            rows={2} value={plan.reason} onChange={(e) => set({ reason: e.target.value })}
            placeholder="Why does this routine spray make sense without an observation trigger?"
            className="w-full rounded-md border bg-background px-3 py-2 text-xs"
          />
        </div>
      )}

      {plan.classification && (
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Targets</Label>
          <div className="flex flex-wrap gap-1.5">
            {targetOptions.length === 0 && (
              <span className="text-xs text-muted-foreground">
                {plan.classification === "Curative" ? "No pest or disease scouted on this block yet." : "No pests or diseases are linked to this crop yet."}
              </span>
            )}
            {[...new Set(targetOptions)].sort().map((t) => {
              const on = plan.targets.includes(t);
              return (
                <button
                  key={t} type="button" aria-pressed={on}
                  onClick={() => set({ targets: on ? plan.targets.filter((x) => x !== t) : [...plan.targets, t] })}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[0.7rem] transition-colors",
                    on ? "border-primary bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70",
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Spray team</Label>
          <Select value={plan.team} onValueChange={(v) => set({ team: v })}>
            <SelectTrigger className="h-9" aria-label="Spray team">
              <SelectValue placeholder={teams.length ? "Pick a team" : "No teams yet"} />
            </SelectTrigger>
            <SelectContent>
              {teams.map((t) => <SelectItem key={t.name} value={t.name}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Kit</Label>
          <Select value={plan.kit} onValueChange={(v) => set({ kit: v })}>
            <SelectTrigger className="h-9" aria-label="Kit">
              <SelectValue placeholder={kits.length ? "Pick a kit" : "No kits"} />
            </SelectTrigger>
            <SelectContent>
              {kits.map((k) => <SelectItem key={k.kit} value={k.kit}>{k.kit}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label className="text-xs">Tank mix (BOM)</Label>
        <BomPicker boms={boms} value={plan.bom} onValueChange={(v) => void pickBom(v)} />
        {boms.length === 0 && <span className="text-[0.7rem] text-muted-foreground">No tank mixes on this site yet.</span>}
        {bomError && <span className="text-[0.7rem] text-destructive">{bomError}</span>}
      </div>

      {(plan.chemicals.length > 0 || bomBusy) && (
        <div className="rounded-lg border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-1.5">Chemical</th>
                <th className="px-2 py-1.5 text-right">Rate / 1000 L</th>
                <th className="px-3 py-1.5 text-right">Quantity</th>
              </tr>
            </thead>
            <tbody>
              {bomBusy && (
                <tr><td colSpan={3} className="px-3 py-2"><Skeleton className="h-4 w-full" /></td></tr>
              )}
              {plan.chemicals.map((c, i) => (
                <tr key={`${c.item_code}-${i}`} className="border-b last:border-b-0">
                  <td className="px-3 py-1.5">{c.item_name || c.item_code}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Input
                      type="number" step="any" min={0} aria-label={`Rate of ${c.item_name || c.item_code}`}
                      className="ml-auto h-8 w-24 text-right tabular-nums" value={c.rate}
                      onChange={(e) =>
                        set({ chemicals: plan.chemicals.map((x, j) => (j === i ? { ...x, rate: parseFloat(e.target.value) || 0 } : x)) })
                      }
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {chemicalQty(c.rate, area).toFixed(2)} {c.stock_uom || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SuggestedProductsCard
        embedded
        targets={plan.targets.length ? plan.targets : findings?.targets || []}
        greenhouses={[block.name]}
        sourceWarehouse={store || plan.chemicals.find((c) => c.source)?.source || ""}
        currentItems={plan.chemicals.map((c) => c.item_code)}
        when={when}
        canAdd
        onAdd={(p) =>
          set({
            chemicals: [
              ...planRef.current.chemicals,
              { item_code: p.item_code, item_name: p.item_name, stock_uom: p.stock_uom, rate: p.default_rate ?? 0, source: store },
            ],
          })
        }
      />

      {onNext && (
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={onNext}>
            Next block
          </Button>
        </div>
      )}
    </div>
  );
}
