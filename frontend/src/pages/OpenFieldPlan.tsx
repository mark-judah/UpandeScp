import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  type BlockPlan, type OpenFieldGroup,
} from "@/lib/open-field";
import { asStatement, errorText } from "@/lib/errors";
import { mergeDateTime, splitDateTime, todayAt } from "@/lib/utils";

/**
 * Open-field spray plan: select one block or several (avocado blocks, the slices of a
 * pivot), plan each one separately on the right — Preventive or Curative, team, tank
 * mix — then add the whole lot as drafts and send them for approval from the draft
 * list below. One draft Work Order per block, the same one the greenhouse plan makes.
 */
export function OpenFieldPlan({ initialCrop }: { initialCrop?: string } = {}) {
  const toast = useToast();
  const [groups, setGroups] = useState<OpenFieldGroup[]>([]);
  const [loadingBlocks, setLoadingBlocks] = useState(true);
  const [boot, setBoot] = useState<CreatorBootstrap | null>(null);
  const [bootByCrop, setBootByCrop] = useState<Record<string, CreatorBootstrap | null>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [plans, setPlans] = useState<Record<string, BlockPlan>>({});
  const [findings, setFindings] = useState<Record<string, BlockFindings>>({});
  const [sprayDate, setSprayDate] = useState(todayAt("06:00"));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchOpenFieldBlocks()
      .then((r) => setGroups(r.groups || []))
      .catch((e) => toast.show(asStatement(errorText(e, "Could not load the blocks.")), "err"))
      .finally(() => setLoadingBlocks(false));
    fetchCreatorBootstrap(initialCrop)
      .then(setBoot)
      .catch((e) => toast.show(asStatement(errorText(e, "Could not load planning data.")), "err"));
    setBootByCrop({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCrop]);

  const byName = useMemo(
    () => new Map(groups.flatMap((g) => g.blocks).map((b) => [b.name, b])),
    [groups],
  );
  const blocks = useMemo(
    () => selected.map((n) => byName.get(n)).filter((b): b is NonNullable<typeof b> => !!b),
    [selected, byName],
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

  const onSelect = useCallback((next: string[]) => {
    setSelected(next);
    setPlans((prev) => Object.fromEntries(next.map((n) => [n, prev[n] ?? emptyPlan()])));
  }, []);

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
    <div className="flex min-h-svh flex-col">
      <PageHeader title="Open-field spray plan" eyebrow="Select blocks · Plan each · Submit for approval">
        <a href="/scp_app#/historical" className="text-xs text-muted-foreground underline">
          View past plans →
        </a>
      </PageHeader>

      <section className="flex flex-col gap-3 border-t px-4 py-4 md:px-6">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[30fr_70fr]">
          <Card className="h-fit p-4">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Blocks</CardTitle>
              <CardDescription>
                {selected.length ? `${selected.length} selected` : "Pick the blocks to spray"}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <BlockMultiPicker groups={groups} selected={selected} onChange={onSelect} loading={loadingBlocks} />
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3">
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-3">
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
              </div>
            </Card>
            <BlockPlanPanel
              blocks={blocks}
              plans={plans}
              onPlanChange={(n, p) => setPlans((prev) => ({ ...prev, [n]: p }))}
              boot={boot}
              bootByCrop={bootByCrop}
              findings={findings}
              when={sprayDate}
            />
            {blocks.length > 0 && (
              <div className="flex items-center justify-end gap-3">
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
          </div>
        </div>

        <DraftBatchPanel onToast={(k, t, ms) => toast.show(asStatement(t), k === "loading" ? "loading" : k, { ms })} onDismiss={toast.dismiss} />
      </section>
    </div>
  );
}
