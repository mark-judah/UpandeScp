/**
 * Pending-Submission spray plan drafts for the current user.
 *
 * Layout: a full-width list of draft rows. Each row leads with the
 * greenhouse (the operator's mental anchor when juggling multiple plans
 * in a batch), followed by the Work Order ID. Clicking a row opens a
 * read-only modal with the full draft contents — chemicals, source
 * warehouses, targets, water, team — so the operator can verify what
 * was captured without leaving the page. The modal is read-only because
 * edits aren't supported in this iteration; remove + re-create is the
 * intended path for changes.
 *
 * Listens for the "spray-plan:draft-added" window event so newly
 * created drafts refresh the list without a manual reload.
 *
 * Submit-all calls submit_drafts_for_approval (race-free bulk transition).
 */

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Trash2,
  Send,
  AlertTriangle,
  Eye,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  deleteDraftPlan,
  fetchDraftPlan,
  listMyDraftPlans,
  submitDraftsForApproval,
  type DraftPlanDetail,
  type DraftSummary,
} from "@/lib/spray-plan-creator-api";
import { FrappeError } from "@/lib/frappe";

interface Props {
  onToast: (kind: "ok" | "err" | "loading" | "warn", text: string, autoMs?: number) => number;
  onDismiss: (id: number) => void;
}

export function DraftBatchPanel({ onToast, onDismiss }: Props) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<DraftPlanDetail | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    listMyDraftPlans()
      .then((rows) => setDrafts(rows))
      .catch((e) => {
        if (e instanceof FrappeError && e.status === 403) {
          setDrafts([]);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener("spray-plan:draft-added", handler);
    return () => window.removeEventListener("spray-plan:draft-added", handler);
  }, [refresh]);

  const remove = async (name: string, ev?: React.MouseEvent) => {
    ev?.stopPropagation();
    const tid = onToast("loading", `Removing ${name}…`, 0);
    try {
      await deleteDraftPlan(name);
      onDismiss(tid);
      onToast("ok", `${name} removed.`);
      refresh();
    } catch (e) {
      onDismiss(tid);
      onToast("err", e instanceof Error ? e.message : String(e));
    }
  };

  const openDetail = async (name: string) => {
    setDetail(null);
    setDetailOpen(true);
    setDetailLoading(true);
    try {
      const d = await fetchDraftPlan(name);
      setDetail(d);
    } catch (e) {
      onToast("err", e instanceof Error ? e.message : String(e));
      setDetailOpen(false);
    } finally {
      setDetailLoading(false);
    }
  };

  const submitAll = async () => {
    if (!drafts.length) return;
    setBusy(true);
    const tid = onToast("loading", `Submitting ${drafts.length} draft(s) for approval…`, 0);
    try {
      const result = await submitDraftsForApproval(drafts.map((d) => d.name));
      onDismiss(tid);
      if (result.skipped.length > 0) {
        onToast(
          "ok",
          `Submitted ${result.submitted.length} · ${result.skipped.length} skipped.`,
          6000,
        );
      } else {
        onToast("ok", `Submitted ${result.submitted.length} for approval.`);
      }
      refresh();
    } catch (e) {
      onDismiss(tid);
      onToast("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-3">
            <span>Draft batch ({drafts.length})</span>
            {drafts.length > 0 && (
              <Button
                onClick={submitAll}
                disabled={busy}
                size="sm"
                className="h-7"
              >
                {busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                Submit all
              </Button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && (
            <div className="px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading drafts…
            </div>
          )}
          {error && (
            <div className="px-4 py-3 text-xs text-destructive flex items-start gap-1">
              <AlertTriangle className="h-3 w-3 mt-[1px]" />
              <span>{error}</span>
            </div>
          )}
          {!loading && !error && drafts.length === 0 && (
            <div className="px-4 py-3 text-xs text-muted-foreground">
              No drafts yet. Build a plan above, click <b>Add to batch</b>,
              and it appears here.
            </div>
          )}
          {!loading && !error && drafts.length > 0 && (
            <ul className="divide-y">
              {drafts.map((d) => (
                <li
                  key={d.name}
                  className="px-3 py-2 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => openDetail(d.name)}
                  title="Click to view chemicals & sources"
                >
                  <div className="flex items-center gap-3">
                    {/* Greenhouse — the major anchor on the left */}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold truncate flex items-center gap-1">
                        {d.has_warnings && (
                          <span
                            title={d.warning_text || "This draft has warnings."}
                            aria-label="Has warnings"
                            className="inline-flex shrink-0"
                          >
                            <AlertTriangle className="h-3 w-3 text-amber-500" />
                          </span>
                        )}
                        <span className="truncate">{d.greenhouse}</span>
                      </div>
                      <div className="text-[0.65rem] text-muted-foreground truncate">
                        {d.classification}
                        {d.scheduled_date ? ` · ${d.scheduled_date}` : ""}
                        {d.chemical_count
                          ? ` · ${d.chemical_count} chemical${d.chemical_count === 1 ? "" : "s"}`
                          : ""}
                      </div>
                    </div>
                    {/* Work Order ID — secondary anchor */}
                    <div className="text-[0.65rem] font-mono text-muted-foreground shrink-0 hidden sm:block">
                      {d.name}
                    </div>
                    {/* Quick-view + Delete */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetail(d.name);
                        }}
                        title="View chemicals & sources"
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => remove(d.name, e)}
                        title="Remove from batch"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  {d.has_warnings && d.warning_text && (
                    <div className="mt-1 text-[0.65rem] text-amber-700 dark:text-amber-300">
                      {d.warning_text}
                    </div>
                  )}
                  {d.targets.length > 0 && (
                    <div className="mt-0.5 text-[0.6rem] text-muted-foreground truncate">
                      {d.targets.slice(0, 6).join(", ")}
                      {d.targets.length > 6 && ` · +${d.targets.length - 6}`}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {detail ? detail.custom_greenhouse : "Draft details"}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {detail ? (
                <span className="font-mono">{detail.name}</span>
              ) : detailLoading ? (
                "Loading…"
              ) : null}
            </DialogDescription>
          </DialogHeader>
          {detailLoading && (
            <div className="text-xs text-muted-foreground flex items-center gap-2 py-6">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading draft…
            </div>
          )}
          {!detailLoading && detail && (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <Field label="Classification" value={detail.custom_classification} />
                <Field
                  label="Spray type"
                  value={detail.custom_spray_type || "—"}
                />
                <Field label="Scope" value={detail.custom_scope || "—"} />
                <Field
                  label="Scope details"
                  value={detail.custom_scope_details || "—"}
                />
                <Field label="Kit" value={detail.custom_kit || "—"} />
                <Field
                  label="Spray team"
                  value={detail.custom_spray_team || "—"}
                />
                <Field
                  label="Scheduled"
                  value={detail.custom_scheduled_application_time || "—"}
                />
                <Field
                  label="Cost center"
                  value={detail.custom_cost_center || "—"}
                />
                <Field
                  label="Water"
                  value={
                    detail.custom_water_volume
                      ? `${detail.custom_water_volume} L · pH ${
                          detail.custom_water_ph ?? "—"
                        } · hardness ${detail.custom_water_hardness ?? "—"}`
                      : "—"
                  }
                />
                <Field
                  label="Area"
                  value={detail.custom_area ? `${detail.custom_area} ha` : "—"}
                />
              </div>

              {detail.custom_targets.length > 0 && (
                <div>
                  <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground mb-0.5">
                    Targets
                  </div>
                  <div className="text-xs">{detail.custom_targets.join(", ")}</div>
                </div>
              )}

              {detail.custom_preventive_reason && (
                <div>
                  <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground mb-0.5">
                    Preventive reason
                  </div>
                  <div className="text-xs whitespace-pre-wrap">
                    {detail.custom_preventive_reason}
                  </div>
                </div>
              )}

              <div>
                <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground mb-1">
                  Chemicals
                </div>
                {detail.chemicals.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No chemicals.</div>
                ) : (
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left font-medium py-1 pr-2">Chemical</th>
                        <th className="text-right font-medium py-1 pr-2 tabular-nums">
                          Qty
                        </th>
                        <th className="text-left font-medium py-1 pr-2">UOM</th>
                        <th className="text-left font-medium py-1">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.chemicals.map((c, i) => (
                        <tr
                          key={`${c.item_code}-${i}`}
                          className="border-b last:border-b-0"
                        >
                          <td className="py-1 pr-2">
                            {c.item_name || c.item_code}
                          </td>
                          <td className="py-1 pr-2 text-right tabular-nums">
                            {c.application_rate ?? "—"}
                          </td>
                          <td className="py-1 pr-2">{c.stock_uom || "—"}</td>
                          <td className="py-1 text-muted-foreground">
                            {c.source_warehouse || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {detail.custom_spray_plan_team_members.length > 0 && (
                <div>
                  <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground mb-1">
                    Team
                  </div>
                  <ul className="text-xs space-y-0.5">
                    {detail.custom_spray_plan_team_members.map((m, i) => (
                      <li key={`${m.employee}-${i}`}>
                        {m.employee_name || m.employee} —{" "}
                        <span className="text-muted-foreground">{m.role}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xs">{value}</div>
    </div>
  );
}
