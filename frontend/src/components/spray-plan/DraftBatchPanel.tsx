/**
 * Right-rail panel listing the current user's Pending Submission spray plan
 * drafts. Listens for the "spray-plan:draft-added" window event so newly
 * created drafts refresh the list without a manual reload.
 *
 * Submit-all calls submit_drafts_for_approval (race-free bulk transition).
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, Send, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  deleteDraftPlan,
  listMyDraftPlans,
  submitDraftsForApproval,
  type DraftSummary,
} from "@/lib/spray-plan-creator-api";
import { FrappeError } from "@/lib/frappe";

interface Props {
  onToast: (kind: "ok" | "err" | "loading", text: string, autoMs?: number) => number;
  onDismiss: (id: number) => void;
}

export function DraftBatchPanel({ onToast, onDismiss }: Props) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const remove = async (name: string) => {
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
    <Card className="sticky top-20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>Draft batch ({drafts.length})</span>
          {drafts.length > 0 && (
            <Button onClick={submitAll} disabled={busy} size="sm" className="h-7">
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
                className="px-3 py-2 flex flex-col gap-0.5 text-xs hover:bg-muted/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium flex items-center gap-1">
                    {d.has_warnings && (
                      <span
                        title={d.warning_text || "This draft has warnings."}
                        aria-label="Has warnings"
                        className="inline-flex"
                      >
                        <AlertTriangle className="h-3 w-3 text-amber-500" />
                      </span>
                    )}
                    <span>{d.name}</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => remove(d.name)}
                    title="Remove from batch"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                {d.has_warnings && d.warning_text && (
                  <div className="text-[0.65rem] text-amber-700 dark:text-amber-300">
                    {d.warning_text}
                  </div>
                )}
                <div className="text-[0.65rem] text-muted-foreground">
                  {d.greenhouse} · {d.classification}
                </div>
                <div className="text-[0.65rem] text-muted-foreground">
                  {d.targets.slice(0, 4).join(", ")}
                  {d.targets.length > 4 && ` · +${d.targets.length - 4}`}
                </div>
                {d.scheduled_date && (
                  <div className="text-[0.6rem] text-muted-foreground tabular-nums">
                    {d.scheduled_date}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
