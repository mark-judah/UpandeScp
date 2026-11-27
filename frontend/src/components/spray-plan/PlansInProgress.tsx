/**
 * Plans in progress: the plans that have left the draft list (sent for approval and
 * beyond), each with its stage and how complete its spray ticket is. A plan no longer
 * disappears once it is submitted; the planner follows it to Completed here and opens
 * the ticket (printable at 100%) from the row.
 */
import { useCallback, useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Bar, TextSkeleton } from "@/components/Loading";
import { SprayTicketDialog } from "@/components/spray-plan/SprayTicketDialog";
import { fetchLifecycleSummary, type LifecycleSummaryRow } from "@/lib/lifecycle-api";
import { getSprayTicket } from "@/lib/spray-ticket-api";
import { errorText } from "@/lib/errors";
import { cn, ymd } from "@/lib/utils";

/** How far back the list reaches (by plan creation). */
export const IN_PROGRESS_DAYS = 30;

const STATE_TONE: Record<string, string> = {
  "Awaiting Approval": "bg-amber-500/15 text-amber-700",
  Approved: "bg-sky-500/15 text-sky-700",
  "Chemical Issued": "bg-indigo-500/15 text-indigo-700",
  "Tank Mix Manufactured": "bg-violet-500/15 text-violet-700",
  "Spraying In Progress": "bg-blue-500/15 text-blue-700",
  Completed: "bg-emerald-500/15 text-emerald-700",
};

const STATES = Object.keys(STATE_TONE);

function blockLabel(place: string | null): string {
  return (place || "").replace(/\s+-\s+[A-Z0-9]+$/, "") || "—";
}

export function PlansInProgress({ crop }: { crop?: string }) {
  const [rows, setRows] = useState<LifecycleSummaryRow[] | null>(null);
  const [percent, setPercent] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [ticketWo, setTicketWo] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const since = new Date();
    since.setDate(since.getDate() - IN_PROGRESS_DAYS);
    setError(null);
    fetchLifecycleSummary({ from_date: ymd(since), states: STATES, crop })
      .then((r) => {
        setRows(r);
        // The ticket % per plan; a plan the user cannot open shows no figure.
        r.forEach((row) =>
          getSprayTicket(row.name)
            .then((t) => setPercent((p) => ({ ...p, [row.name]: t.percent })))
            .catch(() => setPercent((p) => ({ ...p, [row.name]: null }))),
        );
      })
      .catch((e) => setError(errorText(e, "Could not load the plans in progress.")));
  }, [crop]);

  useEffect(() => {
    refresh();
    const again = () => refresh();
    window.addEventListener("spray-plan:submitted", again);
    return () => window.removeEventListener("spray-plan:submitted", again);
  }, [refresh]);

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between gap-3 text-sm">
            <span>In progress ({rows ? rows.length : <TextSkeleton width="1.5ch" />})</span>
            <Button variant="ghost" size="sm" className="h-7" onClick={refresh} aria-label="Refresh plans in progress">
              <RefreshCw className="h-3 w-3" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error && <p className="px-4 py-3 text-xs text-destructive">{error}</p>}
          {!rows && !error && (
            <ul className="divide-y" aria-hidden>
              {[0, 1, 2].map((i) => (
                <li key={i} className="px-4 py-3"><Bar className="h-4 w-full" /></li>
              ))}
            </ul>
          )}
          {rows && rows.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No plans sent for approval in the last {IN_PROGRESS_DAYS} days.
            </p>
          )}
          {rows && rows.length > 0 && (
            <ul className="divide-y">
              {rows.map((r) => {
                const pct = percent[r.name];
                return (
                  <li key={r.name} className="flex items-center gap-3 px-4 py-2 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{blockLabel(r.greenhouse)}</div>
                      <div className="truncate text-muted-foreground">
                        {r.name}{r.scheduled ? ` · ${r.scheduled.slice(0, 16)}` : ""}
                      </div>
                    </div>
                    <span className={cn("rounded-full px-2 py-0.5 text-[11px]", STATE_TONE[r.current_state] || "bg-muted")}>
                      {r.current_state}
                    </span>
                    <span className="w-10 text-right tabular-nums" title="Spray ticket complete">
                      {pct === undefined ? <TextSkeleton width="3ch" /> : pct === null ? "—" : `${pct}%`}
                    </span>
                    <Button variant="outline" size="sm" className="h-7" onClick={() => setTicketWo(r.name)}>
                      <FileText className="h-3 w-3" /> Ticket
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
      <SprayTicketDialog workOrder={ticketWo} onClose={() => setTicketWo(null)} />
    </>
  );
}
