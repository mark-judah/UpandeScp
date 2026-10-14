/**
 * Stale spray plans: planned before the reservation window, never issued and
 * never stopped. They no longer reserve stock but clutter the approval queue.
 * Collapsed until opened so the list is only fetched when someone wants it.
 */
import { useCallback, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/Toast";
import { getStalePlans, stopStalePlans, type StalePlan } from "@/lib/scouting-api";

export function StalePlansCard({ farm }: { farm?: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<StalePlan[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      setRows(await getStalePlans(farm));
      setSel(new Set());
    } catch {
      setErr("Stale plans are only available to the General Manager and store keepers.");
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [farm]);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

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

  const all = rows && rows.length > 0 && sel.size === rows.length;

  return (
    <Card className="p-0">
      <button
        type="button"
        onClick={toggleOpen}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium"
      >
        <span>
          Stale plans
          {rows ? <span className="ml-2 text-muted-foreground tabular-nums">{rows.length}</span> : null}
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <CardContent className="space-y-2 px-4 pb-4 pt-0">
          <p className="text-xs text-muted-foreground">
            Planned before the reservation window and never issued. Submitted plans are stopped;
            unsubmitted drafts are deleted.
          </p>
          {busy && !rows ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {err ? <p className="text-xs text-destructive">{err}</p> : null}
          {rows && rows.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={!!all}
                    onCheckedChange={(v) => setSel(v ? new Set(rows.map((r) => r.name)) : new Set())}
                  />
                  Select all
                </label>
                <Button size="sm" className="h-8" disabled={!sel.size || busy} onClick={stop}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Stop selected{sel.size ? ` (${sel.size})` : ""}
                </Button>
              </div>
              <div className="max-h-72 overflow-auto rounded-md border divide-y">
                {rows.map((r) => (
                  <label key={r.name} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                    <Checkbox
                      checked={sel.has(r.name)}
                      onCheckedChange={(v) =>
                        setSel((s) => {
                          const n = new Set(s);
                          if (v) n.add(r.name); else n.delete(r.name);
                          return n;
                        })
                      }
                    />
                    <span className="font-mono">{r.name}</span>
                    <span className="text-muted-foreground">{r.custom_greenhouse || ""}</span>
                    <span className="ml-auto text-muted-foreground tabular-nums">
                      {r.workflow_state || "Draft"} · planned {r.planned_start_date.slice(0, 10)}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}
          {rows && !rows.length && !err && !busy ? (
            <p className="text-xs text-muted-foreground">No stale plans.</p>
          ) : null}
        </CardContent>
      )}
    </Card>
  );
}
