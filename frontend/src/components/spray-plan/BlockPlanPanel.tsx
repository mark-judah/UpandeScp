/**
 * The right-hand planning panel of the open-field spray plan: one section per
 * selected block, each planned separately — Preventive or Curative, then the team,
 * then the tank mix (BOM) — with the block's own scouted findings and suggested
 * chemicals. A jump dropdown lists every selected block. When more than
 * COLLAPSE_ABOVE blocks are selected the sections collapse to a header (a dropdown
 * per block) and one is open at a time, so the planner works down the list.
 *
 * Each block's form is the shared spray plan form (plan-form/, the roses greenhouse
 * plan's): its own tank mix with New tank mix, Add chemical, Available net of other
 * drafts and of the other selected blocks, Batch, MOA and Scheduled Application.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronsUpDown, ChevronRight, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CropChip } from "@/components/CropChip";
import { SuggestedProductsCard } from "@/components/spray-plan/SuggestedProducts";
import { SprayPlanForm } from "@/components/spray-plan/plan-form/SprayPlanForm";
import { useSprayPlanForm } from "@/components/spray-plan/plan-form/useSprayPlanForm";
import type { CreatorBootstrap } from "@/lib/spray-plan-creator-api";
import type { BlockFindings } from "@/lib/open-field-api";
import {
  effectiveArea, planProblems, reservedElsewhere, shouldCollapse,
  type BlockPlan, type OpenFieldBlock,
} from "@/lib/open-field";
import { cn } from "@/lib/utils";

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
  /** the default Scheduled Application of a block's plan (each block may change its own) */
  when: string;
  /** a tank mix was made from a block's form: refresh the planning data */
  onTankMixCreated?: (bom: string) => Promise<void> | void;
  /** a block picked in Jump to block (the page moves its map there) */
  onJump?: (block: string) => void;
  /** take a block out of the selection (its header's X) */
  onRemove?: (block: string) => void;
  /** the user tried to submit: outline every missing required field */
  showErrors?: boolean;
}

export function BlockPlanPanel({
  blocks, plans, onPlanChange, boot, bootByCrop, findings, when, onTankMixCreated, onJump, onRemove, showErrors,
}: PanelProps) {
  // The block just jumped to wears a ring for a moment so the eye finds it.
  const [flash, setFlash] = useState<string>("");
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(""), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  const collapsed = shouldCollapse(blocks.length);
  const [open, setOpen] = useState<string>(blocks[0]?.name ?? "");
  const refs = useRef<Record<string, HTMLElement | null>>({});

  // Keep the open block valid as blocks are picked and dropped.
  useEffect(() => {
    if (!blocks.some((b) => b.name === open)) setOpen(blocks[0]?.name ?? "");
  }, [blocks, open]);

  // Each block's Available also nets off what the other selected blocks draw.
  const elsewhere = useMemo(
    () => Object.fromEntries(blocks.map((b) => [b.name, reservedElsewhere(b.name, blocks, plans)])),
    [blocks, plans],
  );
  const ready = (b: OpenFieldBlock) =>
    planProblems(plans[b.name], effectiveArea(b, plans[b.name]), elsewhere[b.name]).length === 0;
  const done = blocks.filter(ready).length;

  const jump = (name: string) => {
    setOpen(name);
    // after the section opens, bring it into view
    setTimeout(() => refs.current[name]?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 60);
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
        <JumpDropdown
          blocks={blocks}
          ready={ready}
          onPick={(name) => {
            jump(name);
            setFlash(name);
            onJump?.(name);
          }}
        />
        <span className="text-xs tabular-nums text-muted-foreground">
          {done} of {blocks.length} ready
        </span>
      </div>
      {blocks.map((b) => {
        const isOpen = !collapsed || open === b.name;
        const plan = plans[b.name];
        const problems = planProblems(plan, effectiveArea(b, plan), elsewhere[b.name]);
        return (
          <section
            key={b.name}
            data-testid="block-section"
            data-open={isOpen || undefined}
            data-flash={flash === b.name || undefined}
            ref={(el) => { refs.current[b.name] = el; }}
            className={cn(
              "scroll-mt-4 rounded-xl border bg-card transition-shadow",
              flash === b.name && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
            )}
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
              {onRemove && (
                <button
                  type="button"
                  aria-label={`Remove ${b.label} from the plan`}
                  title="Remove this block from the plan"
                  className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Only a block with chemicals entered has work to lose.
                    const hasWork = (plan?.chemicals || []).some((c) => c.item_code);
                    if (hasWork && !window.confirm(`Remove ${b.label}? Its chemicals will be dropped from this plan.`)) return;
                    onRemove(b.name);
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
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
                reserved={elsewhere[b.name]}
                onTankMixCreated={onTankMixCreated}
                showErrors={showErrors}
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
      {/* No focus return to the trigger on close: it scrolled the panel back to the top,
          undoing the jump. */}
      <PopoverContent align="start" className="w-64 p-1" onCloseAutoFocus={(e) => e.preventDefault()}>
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
  block, plan, onChange, boot, findings, when, reserved, onTankMixCreated, onNext, showErrors,
}: {
  block: OpenFieldBlock;
  plan: BlockPlan;
  onChange: (p: BlockPlan) => void;
  boot: CreatorBootstrap | null;
  findings?: BlockFindings;
  when: string;
  reserved?: Record<string, number>;
  onTankMixCreated?: (bom: string) => Promise<void> | void;
  onNext?: () => void;
  showErrors?: boolean;
}) {
  const stores = (block.farm && boot?.farm_stores?.[block.farm]) || null;
  const store = stores?.chemical_store || "";
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

  // The shared plan form (the roses greenhouse plan's), one per block: its own tank
  // mix, chemicals, batches and Scheduled Application. The block's farm store is
  // the source, as a greenhouse's farm store is.
  const state = useSprayPlanForm({
    place: block.name,
    placeKind: "block",
    crop: block.crop || block.crop_label,
    farm: block.farm || "",
    areaHa: effectiveArea(block, plan),
    reservedElsewhere: reserved,
    stores,
    value: plan,
    onChange,
    defaultScheduledAt: when,
  });

  if (!boot) {
    return (
      <div className="flex flex-col gap-3 px-4 pb-4" aria-busy="true" data-skeleton="plan">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}
      </div>
    );
  }

  // Curative targets are what was scouted on the block; preventive may name any
  // registered pest or disease of the crop.
  const targetOptions =
    plan.classification === "Preventive"
      ? [...(boot?.pest_catalog || []).map((p) => p.name), ...(boot?.disease_catalog || []).map((d) => d.name)]
      : findings?.targets || [];

  return (
    <div className="px-4 pb-4">
      <SprayPlanForm
        compact
        state={state}
        teams={teams}
        crop={block.crop || block.crop_label || undefined}
        kits={kits}
        showMethod
        boms={boms}
        bomHint={
          boms.length === 0 ? (
            <span className="text-[0.7rem] text-muted-foreground">No tank mixes on this site yet.</span>
          ) : null
        }
        onTankMixCreated={onTankMixCreated}
        showErrors={showErrors}
        placeNote={block.cost_center ? `cost centre ${block.cost_center}` : "cost centre derived on save"}
        topSlot={
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
        }
        targetsSlot={
          plan.classification ? (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">
                Targets
                <span className="ml-1.5 text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground" data-required>
                  Required
                </span>
              </Label>
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
                      onClick={() => state.setTargets((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))}
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
          ) : null
        }
        suggestionsSlot={
          <SuggestedProductsCard
            embedded
            collapsible
            targets={plan.targets.length ? plan.targets : findings?.targets || []}
            greenhouses={[block.name]}
            sourceWarehouse={store || plan.chemicals.find((c) => c.source)?.source || ""}
            currentItems={plan.chemicals.map((c) => c.item_code)}
            when={state.scheduledAt}
            canAdd
            onAdd={(p) =>
              void state.addChemical(
                {
                  item_code: p.item_code,
                  item_name: p.item_name,
                  stock_uom: p.stock_uom,
                  uoms: p.uoms,
                  item_group: p.item_group,
                  is_fertilizer: false,
                },
                p.default_rate,
                store || undefined,
              )
            }
          />
        }
        footer={
          onNext ? (
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={onNext}>
                Next block
              </Button>
            </div>
          ) : null
        }
      />
    </div>
  );
}
