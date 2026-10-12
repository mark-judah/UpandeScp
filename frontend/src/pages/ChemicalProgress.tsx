/**
 * Chemical Progress — the storesman's window onto where each spray plan is in
 * the chemical flow: issued → labels printed → scanned (tank mix) → spraying →
 * done. Built on the shared lifecycle endpoint + <LifecycleTimeline>, so it
 * shows exactly what the GM and creator see, framed around the steps the store
 * acts on.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, AlertTriangle, RefreshCw, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HeaderIconButton } from "@/components/header-controls";
import { PlacePicker } from "@/components/PlacePicker";
import { PageHeader } from "@/components/PageHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DatePicker } from "@/components/DatePicker";
import { LoadingStrip } from "@/components/LoadingStrip";
import { TableRowsSkeleton, firstLoad } from "@/components/Loading";
import { LifecycleTimeline } from "@/components/spray-plan/LifecycleTimeline";
import {
  fetchLifecycle,
  fetchLifecycleSummary,
  type Lifecycle,
  type LifecycleSummaryRow,
} from "@/lib/lifecycle-api";
import { ymd, cn } from "@/lib/utils";
import { farmPrefix } from "@/lib/places";

const ALL = "__all__";

// Stage → badge tone. The store cares most about the middle of the flow.
const STATE_TONE: Record<string, string> = {
  "Pending Submission": "bg-muted text-muted-foreground",
  "Awaiting Approval": "bg-amber-500/15 text-amber-600",
  Approved: "bg-sky-500/15 text-sky-600",
  "Chemical Issued": "bg-indigo-500/15 text-indigo-600",
  "Tank Mix Manufactured": "bg-violet-500/15 text-violet-600",
  "Spraying In Progress": "bg-blue-500/15 text-blue-600",
  Completed: "bg-emerald-500/15 text-emerald-600",
};

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14);
  return { from: ymd(from), to: ymd(today) };
}

export function ChemicalProgress() {
  const [from, setFrom] = useState(defaultRange().from);
  const [to, setTo] = useState(defaultRange().to);
  const [farm, setFarm] = useState(ALL);
  const [rows, setRows] = useState<LifecycleSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  // An empty list is a valid answer, so "has data" is "a response landed".
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lifecycle, setLifecycle] = useState<Lifecycle | null>(null);
  const [lcLoading, setLcLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchLifecycleSummary({ from_date: from, to_date: to })
      .then((r) => {
        setRows(r);
        setLoaded(true);
      })
      .catch((e) =>
        setError(
          e?.message?.includes("permission")
            ? "You do not have permission to view chemical progress."
            : "Failed to load chemical progress.",
        ),
      )
      .finally(() => setLoading(false));
  };

  useEffect(load, [from, to]);

  // The summary rows carry no farm, so the farm is read off the house name
  // (lib/places `farmPrefix`, the one shared copy of that rule).
  const farms = useMemo(
    () => Array.from(new Set(rows.map((r) => farmPrefix(r.greenhouse)).filter(Boolean))).sort(),
    [rows],
  );

  const visible = useMemo(
    () => (farm === ALL ? rows : rows.filter((r) => farmPrefix(r.greenhouse) === farm)),
    [rows, farm],
  );

  const skeleton = firstLoad(loading, loaded);

  const missedCount = useMemo(() => visible.filter((r) => r.missed).length, [visible]);

  const toggle = (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      setLifecycle(null);
      return;
    }
    setExpanded(name);
    setLifecycle(null);
    setLcLoading(true);
    fetchLifecycle(name)
      .then(setLifecycle)
      .catch(() => setLifecycle(null))
      .finally(() => setLcLoading(false));
  };

  return (
    <div className="flex flex-col min-h-svh">
      <PageHeader
        title="Chemical Progress"
        eyebrow="Follow each plan from issue → scan → tank mix → spray"
      >
        {missedCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--sd-data-red)]/15 text-[var(--sd-data-red)] px-2.5 py-1 text-xs font-medium">
            <AlertTriangle className="h-3 w-3" />
            {missedCount} missed window
          </span>
        )}
        <HeaderIconButton onClick={load} title="Refresh" disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </HeaderIconButton>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2 px-4 md:px-6">
        <DatePicker value={from} onChange={setFrom} />
        <DatePicker value={to} onChange={setTo} />
        <PlacePicker
          level="farm"
          farms={farms}
          value={{ farm: farm === ALL ? "" : farm, greenhouse: "" }}
          onChange={(p) => setFarm(p.farm || ALL)}
          disabled={skeleton}
        />
      </div>

      <div className="px-4 md:px-6 py-4 flex-1" aria-busy={loading || undefined}>
        {error && (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        {!error && !visible.length && !loading && (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              No spray plans in this selection.
            </CardContent>
          </Card>
        )}

        {!error && (visible.length > 0 || skeleton) && (
          <Card className="p-0">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Work Order</TableHead>
                    <TableHead>Greenhouse</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skeleton && <TableRowsSkeleton cols={5} rows={8} />}
                  {visible.map((r) => {
                    const open = expanded === r.name;
                    return (
                      <Fragment key={r.name}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => toggle(r.name)}
                        >
                          <TableCell className="text-xs font-medium">{r.name}</TableCell>
                          <TableCell className="text-xs">{r.greenhouse || "—"}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge
                                className={cn(
                                  "text-[0.6rem]",
                                  r.stopped
                                    ? "bg-[var(--sd-data-red)]/15 text-[var(--sd-data-red)]"
                                    : STATE_TONE[r.current_state] || "bg-muted text-muted-foreground",
                                )}
                              >
                                {r.stopped ? "Cancelled" : r.current_state}
                              </Badge>
                              {r.missed && (
                                <span className="inline-flex items-center gap-1 text-[0.6rem] font-medium text-[var(--sd-data-red)]">
                                  <AlertTriangle className="h-3 w-3" />
                                  Missed
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">
                            {r.scheduled ? r.scheduled.slice(0, 16) : "—"}
                          </TableCell>
                          <TableCell>
                            <ChevronDown
                              className={cn(
                                "h-4 w-4 transition-transform text-muted-foreground",
                                open && "rotate-180",
                              )}
                            />
                          </TableCell>
                        </TableRow>
                        {open && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={5} className="p-4">
                              <LifecycleTimeline lifecycle={lifecycle} loading={lcLoading} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      <LoadingStrip active={loading} />
    </div>
  );
}
