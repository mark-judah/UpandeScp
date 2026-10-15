/**
 * Stale spray plans: planned before the reservation window, never issued and
 * never stopped. They no longer reserve stock but clutter the approval queue.
 * The GM can stop them, or "Re-plan" one: the floor plan opens pre-filled with
 * the same greenhouse, targets and chemicals for a new date.
 */
import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/Toast";
import { parseTargets } from "@/lib/spray-plan-api";
import { getStalePlans, stopStalePlans, type StalePlan } from "@/lib/scouting-api";
import { cropSlug } from "@/lib/router";
import { ymd } from "@/lib/utils";

/**
 * Deep link into the floor plan. Query params after the hash route:
 *   replan=<stale WO name>  greenhouse=<name>  date=<YYYY-MM-DD, tomorrow>
 *   target=<pest>  (repeated)   item=<chemical item code>  (repeated)
 */
export function replanHref(plan: StalePlan, crop: string, now = new Date()): string {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  const q = new URLSearchParams();
  q.set("replan", plan.name);
  if (plan.custom_greenhouse) q.set("greenhouse", plan.custom_greenhouse);
  q.set("date", ymd(next));
  parseTargets(plan.custom_targets ?? "").forEach((t) => q.append("target", t));
  (plan.items ?? []).forEach((i) => q.append("item", i));
  return `#/${cropSlug(crop)}/application-plan?${q.toString()}`;
}

export function StalePlansTab({
  farm,
  crop,
  onCount,
}: {
  farm?: string;
  crop: string;
  onCount?: (n: number) => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<StalePlan[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await getStalePlans(farm);
      setRows(r);
      onCount?.(r.length);
      setSel(new Set());
    } catch {
      setErr("Stale plans are only available to the General Manager and store keepers.");
      setRows([]);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farm]);

  useEffect(() => {
    void load();
  }, [load]);

  const stop = async () => {
    if (!sel.size) return;
    setBusy(true);
    try {
      const r = await stopStalePlans(Array.from(sel));
      const done = r.stopped.length + r.deleted.length;
      toast.show(
        `${done} stale plan${done === 1 ? "" : "s"} cleared.`,
        r.failed.length || r.skipped.length ? "warn" : "ok",
        r.failed.length || r.skipped.length
          ? { hint: `${r.failed.length} failed, ${r.skipped.length} skipped (no longer stale).` }
          : undefined,
      );
      await load();
    } catch {
      toast.show("Could not stop the selected plans.", "err");
      setBusy(false);
    }
  };

  const all = !!rows && rows.length > 0 && sel.size === rows.length;

  return (
    <div className="flex flex-col gap-2" data-testid="stale-tab">
      <p className="text-xs text-muted-foreground">
        Planned before the reservation window and never issued. Stopping cancels a submitted plan and deletes an
        unsubmitted draft; re-planning opens the floor plan with the same house, targets and chemicals for a new date.
      </p>
      {busy && !rows ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {err ? <p className="text-xs text-destructive">{err}</p> : null}
      {rows && rows.length > 0 && (
        <div className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={all}
                onCheckedChange={(v) => setSel(v ? new Set(rows.map((r) => r.name)) : new Set())}
              />
              Select all
            </label>
            <Button size="sm" variant="outline" className="h-8 rounded-xl" disabled={!sel.size || busy} onClick={stop}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Stop selected{sel.size ? ` (${sel.size})` : ""}
            </Button>
          </div>
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={r.name} className="flex items-center gap-3 px-4 py-2 text-xs" data-testid="stale-row">
                <Checkbox
                  aria-label={`Select ${r.name}`}
                  checked={sel.has(r.name)}
                  onCheckedChange={(v) =>
                    setSel((s) => {
                      const n = new Set(s);
                      if (v) n.add(r.name);
                      else n.delete(r.name);
                      return n;
                    })
                  }
                />
                <span className="font-medium">{r.name}</span>
                <span className="text-muted-foreground">{r.custom_greenhouse || ""}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {r.workflow_state || "Draft"} · planned {r.planned_start_date.slice(0, 10)}
                </span>
                <a
                  href={replanHref(r, crop)}
                  className="inline-flex items-center gap-1.5 rounded-xl border bg-background px-2.5 py-1 font-medium hover:bg-muted"
                  title="Open the floor plan with this plan's house, targets and chemicals for a new date"
                >
                  <CalendarClock className="h-3.5 w-3.5" />
                  Re-plan
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {rows && !rows.length && !err && !busy ? (
        <div className="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">No stale plans.</div>
      ) : null}
    </div>
  );
}
