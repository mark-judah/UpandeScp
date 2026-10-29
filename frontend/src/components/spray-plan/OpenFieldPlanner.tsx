/**
 * The open-field planning column (what was the Spray Plan page): select one block or several (avocado
 * blocks, the slices of a pivot), plan each one separately — Preventive or Curative, team, tank mix —
 * then add the whole lot as drafts and send them for approval from the draft list below. One draft
 * Work Order per block, the same one the greenhouse plan makes.
 *
 * The selection is the caller's (`selected` / `onSelect`): on the Application Plan the map and this
 * list pick the same blocks. `focus` scrolls a block's row into view (a block picked on the map);
 * `rowExtra` adds a cell to each row (the block's heat for the observation on the map).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/DatePicker";
import { TimePicker } from "@/components/TimePicker";
import { BlockMultiPicker } from "@/components/spray-plan/BlockMultiPicker";
import { BlockPlanPanel } from "@/components/spray-plan/BlockPlanPanel";
import { DraftBatchPanel } from "@/components/spray-plan/DraftBatchPanel";
import { useToast } from "@/components/Toast";
import { fetchCreatorBootstrap, type CreatorBootstrap } from "@/lib/spray-plan-creator-api";
import {
  createDraftPlansBatch, fetchBlockFindings, fetchOpenFieldBlocks, type BlockFindings,
} from "@/lib/open-field-api";
import {
  effectiveArea, emptyPlan, planProblems, toDraftPayload,
  type BlockPlan, type OpenFieldBlock, type OpenFieldGroup,
} from "@/lib/open-field";
import { asStatement, errorText } from "@/lib/errors";
import { mergeDateTime, splitDateTime, todayAt } from "@/lib/utils";

export interface OpenFieldPlannerProps {
  /** The route crop: its blocks are listed and its planning data is the fallback. */
  crop?: string;
  selected: string[];
  onSelect: (next: string[]) => void;
  /** A block to bring into view in the list (picked on the map). */
  focus?: string | null;
  rowExtra?: (block: OpenFieldBlock) => ReactNode;
  /** The plannable blocks, once loaded (the map only picks these). */
  onBlocks?: (groups: OpenFieldGroup[]) => void;
}

export function OpenFieldPlanner({ crop, selected, onSelect, focus, rowExtra, onBlocks }: OpenFieldPlannerProps) {
  const toast = useToast();
  const [groups, setGroups] = useState<OpenFieldGroup[]>([]);
  const [loadingBlocks, setLoadingBlocks] = useState(true);
  const [boot, setBoot] = useState<CreatorBootstrap | null>(null);
  const [bootByCrop, setBootByCrop] = useState<Record<string, CreatorBootstrap | null>>({});
  const [plans, setPlans] = useState<Record<string, BlockPlan>>({});
  const [findings, setFindings] = useState<Record<string, BlockFindings>>({});
  const [sprayDate, setSprayDate] = useState(todayAt("06:00"));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLoadingBlocks(true);
    fetchOpenFieldBlocks(crop)
      .then((r) => {
        setGroups(r.groups || []);
        onBlocks?.(r.groups || []);
      })
      .catch((e) => toast.show(asStatement(errorText(e, "Could not load the blocks.")), "err"))
      .finally(() => setLoadingBlocks(false));
    fetchCreatorBootstrap(crop)
      .then(setBoot)
      .catch((e) => toast.show(asStatement(errorText(e, "Could not load planning data.")), "err"));
    setBootByCrop({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop]);

  const byName = useMemo(
    () => new Map(groups.flatMap((g) => g.blocks).map((b) => [b.name, b])),
    [groups],
  );
  const blocks = useMemo(
    () => selected.map((n) => byName.get(n)).filter((b): b is NonNullable<typeof b> => !!b),
    [selected, byName],
  );

  // A plan per selected block (an empty one until it is started).
  const shownPlans = useMemo(
    () => Object.fromEntries(selected.map((n) => [n, plans[n] ?? emptyPlan()])),
    [selected, plans],
  );

  // Planning data is per crop: a block's targets, tank mixes and suggestions follow the
  // crop it grows, whatever crop route the page was opened from.
  useEffect(() => {
    const crops = [...new Set(blocks.map((b) => b.crop).filter((c): c is string => !!c))];
    for (const c of crops.filter((c) => !(c in bootByCrop))) {
      setBootByCrop((m) => ({ ...m, [c]: null }));
      fetchCreatorBootstrap(c)
        .then((r) => setBootByCrop((m) => ({ ...m, [c]: r })))
        .catch((e) => {
          setBootByCrop((m) => { const { [c]: _, ...rest } = m; return rest; });
          toast.show(asStatement(errorText(e, `Could not load planning data for ${c}.`)), "err");
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  // Scouted findings of the newly picked blocks.
  useEffect(() => {
    const missing = selected.filter((n) => !findings[n]);
    if (!missing.length) return;
    let alive = true;
    fetchBlockFindings(missing)
      .then((r) => alive && setFindings((f) => ({ ...f, ...r })))
      .catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const planOf = (n: string) => plans[n] ?? emptyPlan();
  const incomplete = blocks.filter((b) => planProblems(planOf(b.name), effectiveArea(b, planOf(b.name))).length);

  const submit = async () => {
    if (!blocks.length || incomplete.length) return;
    setBusy(true);
    const loader = toast.show("Creating draft plans…", "loading");
    try {
      const r = await createDraftPlansBatch(
        blocks.map((b) => toDraftPayload(b, planOf(b.name), effectiveArea(b, planOf(b.name)), sprayDate)),
      );
      toast.dismiss(loader);
      const warns = r.results.flatMap((x) => x.warnings.map((w) => `${x.block}: ${w}`));
      toast.show(
        asStatement(`${r.results.length} draft plan${r.results.length === 1 ? "" : "s"} created: ${r.results.map((x) => x.work_order).join(", ")}`),
        "ok",
      );
      if (warns.length) toast.show(asStatement(warns[0]), "warn");
      onSelect([]);
      window.dispatchEvent(new CustomEvent("spray-plan:draft-added"));
    } catch (e) {
      toast.dismiss(loader);
      toast.show(asStatement(errorText(e, "The draft plans could not be created.")), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="open-field-planner">
      <section className="rounded-2xl border bg-card p-3">
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Blocks</h2>
          <span className="text-xs text-muted-foreground">
            {selected.length ? `${selected.length} selected` : "Pick on the map or here"}
          </span>
        </div>
        <BlockMultiPicker
          groups={groups}
          selected={selected}
          onChange={onSelect}
          loading={loadingBlocks}
          focus={focus}
          rowExtra={rowExtra}
        />
      </section>

      {blocks.length > 0 && (
        <section className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-3">
          <Label className="text-xs">Scheduled application</Label>
          <DatePicker
            variant="field"
            value={splitDateTime(sprayDate).date}
            onChange={(d) => setSprayDate(mergeDateTime(d, splitDateTime(sprayDate).time))}
          />
          <TimePicker
            value={splitDateTime(sprayDate).time}
            onChange={(t) => setSprayDate(mergeDateTime(splitDateTime(sprayDate).date, t))}
          />
        </section>
      )}

      <BlockPlanPanel
        blocks={blocks}
        plans={shownPlans}
        onPlanChange={(n, p) => setPlans((prev) => ({ ...prev, [n]: p }))}
        boot={boot}
        bootByCrop={bootByCrop}
        findings={findings}
        when={sprayDate}
      />
      {blocks.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {incomplete.length > 0 && (
            <span className="text-xs text-muted-foreground">
              Still to plan: {incomplete.map((b) => b.label).join(", ")}
            </span>
          )}
          <Button onClick={submit} disabled={busy || incomplete.length > 0} className="rounded-full">
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Create {blocks.length} draft plan{blocks.length === 1 ? "" : "s"}
          </Button>
        </div>
      )}

      <DraftBatchPanel onToast={(k, t, ms) => toast.show(asStatement(t), k === "loading" ? "loading" : k, { ms })} onDismiss={toast.dismiss} />
    </div>
  );
}
