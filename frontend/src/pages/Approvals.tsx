/**
 * Spray Plan Approval — direct port of the legacy
 * `www/spray_plan_approval` page into a React route. The legacy page is
 * a bulk-ops console: select multiple Application Floor Plan work
 * orders, approve them in one pass (creating draft Material Transfer
 * Stock Entries + QR labels per chemical) or reject them, with a live
 * progress panel and a 30×40 mm QR print window.
 *
 * Server access is gated to "Spray Plan Approver" / "General Manager" /
 * "System Manager" on the endpoint side
 * (see ``upande_scp/serverscripts/spray_plan_approval.py``);
 * non-privileged users will still see the route but every API call
 * fails with PermissionError, which we surface as an error state.
 */

import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  Printer,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DatePicker } from "@/components/DatePicker";
import { LoadingStrip } from "@/components/LoadingStrip";
import { ymd, cn } from "@/lib/utils";
import {
  approveWorkOrder,
  fetchFarmsAndGreenhouses,
  fetchPendingWorkOrders,
  formatQty,
  parseTargets,
  stopWorkOrder,
  type ApproveResult,
  type FarmsAndGreenhouses,
  type PendingWorkOrder,
  type QrLabel,
} from "@/lib/spray-plan-api";
import { approveDraftsBulk } from "@/lib/spray-plan-creator-api";
import { ApprovalChemicalsTable } from "@/components/spray-plan/ApprovalChemicalsTable";
import { LifecycleTimelineFor } from "@/components/spray-plan/LifecycleTimeline";
import {
  fetchLifecycleSummary,
  type LifecycleSummaryRow,
} from "@/lib/lifecycle-api";

const ALL = "__all__";
// Pending/forwarded come from the approval feed; the four post-approval
// stages come from the lifecycle summary so the GM sees the whole journey.
type StatusFilter =
  | "pending"
  | "forwarded"
  | "Chemical Issued"
  | "Tank Mix Manufactured"
  | "Spraying In Progress"
  | "Completed";

const STAGE_TABS: { key: StatusFilter; label: string }[] = [
  { key: "Chemical Issued", label: "Chemical Issued" },
  { key: "Tank Mix Manufactured", label: "Tank Mix" },
  { key: "Spraying In Progress", label: "Spraying" },
  { key: "Completed", label: "Completed" },
];

function defaultRange(): { from: string; to: string } {
  // Legacy default = today / today.
  const t = ymd(new Date());
  return { from: t, to: t };
}

interface LogLine {
  text: string;
  variant: "ok" | "warn" | "skip" | "err";
}

interface ProgressState {
  open: boolean;
  title: string;
  fillPct: number;
  isStop: boolean;
  doneColor?: string;
  closable: boolean;
  log: LogLine[];
  qrLabels: QrLabel[];
}

const INITIAL_PROGRESS: ProgressState = {
  open: false,
  title: "",
  fillPct: 0,
  isStop: false,
  closable: false,
  log: [],
  qrLabels: [],
};

export function Approvals() {
  const [from, setFrom] = useState(defaultRange().from);
  const [to, setTo] = useState(defaultRange().to);
  const [farm, setFarm] = useState<string>(ALL);
  const [greenhouse, setGreenhouse] = useState<string>(ALL);
  const [farmsData, setFarmsData] = useState<FarmsAndGreenhouses>({
    farms: [],
    greenhouses_by_farm: {},
  });
  const [allWos, setAllWos] = useState<PendingWorkOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [progress, setProgress] = useState<ProgressState>(INITIAL_PROGRESS);
  const [summary, setSummary] = useState<LifecycleSummaryRow[]>([]);
  const [stageExpanded, setStageExpanded] = useState<string | null>(null);
  const reloadTimerRef = useRef<number | null>(null);

  // ── Data loading ──────────────────────────────────────────────────
  useEffect(() => {
    fetchFarmsAndGreenhouses()
      .then(setFarmsData)
      .catch(() => {});
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const r = await fetchPendingWorkOrders({
        from_date: from || null,
        to_date: to || null,
        farm: farm === ALL ? null : farm,
        greenhouse: greenhouse === ALL ? null : greenhouse,
      });
      setAllWos(r.work_orders || []);
      setChecked(new Set());
      setExpanded(new Set());
      // Post-approval stages come from the lifecycle summary. Best-effort —
      // a failure just leaves the stage tabs empty, it doesn't break approvals.
      fetchLifecycleSummary({
        from_date: from || undefined,
        to_date: to || undefined,
        farm: farm === ALL ? undefined : farm,
        greenhouse: greenhouse === ALL ? undefined : greenhouse,
      })
        .then(setSummary)
        .catch(() => setSummary([]));
    } catch (e: any) {
      setAllWos([]);
      setErrorMsg(
        e?.message?.includes("permission")
          ? "You do not have permission to view spray plan approvals. Ask an admin for the Spray Plan Approver role."
          : "Failed to load work orders. Check your connection or permissions.",
      );
    } finally {
      setLoading(false);
    }
  }, [from, to, farm, greenhouse]);

  // Debounce filter changes so cascading farm→greenhouse doesn't refetch
  // multiple times in quick succession.
  useEffect(() => {
    if (reloadTimerRef.current) window.clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = window.setTimeout(() => {
      void reload();
    }, 150);
    return () => {
      if (reloadTimerRef.current) window.clearTimeout(reloadTimerRef.current);
    };
  }, [reload]);

  // Reset greenhouse when farm changes and the previous selection is no
  // longer in the cascaded list.
  useEffect(() => {
    if (greenhouse === ALL) return;
    const list =
      farm !== ALL ? farmsData.greenhouses_by_farm[farm] || [] : [];
    if (!list.includes(greenhouse)) setGreenhouse(ALL);
  }, [farm, farmsData, greenhouse]);

  // ── Derived ───────────────────────────────────────────────────────
  const pendingCount = useMemo(
    () => allWos.filter((w) => !w.is_forwarded).length,
    [allWos],
  );
  const forwardedCount = useMemo(
    () => allWos.filter((w) => w.is_forwarded).length,
    [allWos],
  );

  const stageCounts = useMemo(() => {
    const c: Record<string, number> = {};
    summary.forEach((r) => {
      c[r.current_state] = (c[r.current_state] || 0) + 1;
    });
    return c;
  }, [summary]);

  const isStageTab = STAGE_TABS.some((t) => t.key === statusFilter);
  const stageRows = useMemo(
    () => summary.filter((r) => r.current_state === statusFilter),
    [summary, statusFilter],
  );

  const visibleWos = useMemo(() => {
    if (statusFilter === "pending") return allWos.filter((w) => !w.is_forwarded);
    if (statusFilter === "forwarded") return allWos.filter((w) => w.is_forwarded);
    // Stage tabs render from the lifecycle summary, not the approval feed.
    return [];
  }, [allWos, statusFilter]);

  // Drop checked WOs that are no longer visible after filter changes.
  useEffect(() => {
    setChecked((prev) => {
      const visNames = new Set(visibleWos.map((w) => w.name));
      const next = new Set<string>();
      prev.forEach((n) => {
        if (visNames.has(n)) next.add(n);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [visibleWos]);

  const ghOptions = useMemo(() => {
    if (farm === ALL) return [];
    return farmsData.greenhouses_by_farm[farm] || [];
  }, [farm, farmsData]);

  const allChecked =
    visibleWos.length > 0 && visibleWos.every((w) => checked.has(w.name));
  const someChecked =
    visibleWos.some((w) => checked.has(w.name)) && !allChecked;

  // ── Selection actions ─────────────────────────────────────────────
  const toggleRow = (name: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    setChecked((prev) => {
      if (allChecked) {
        const next = new Set(prev);
        visibleWos.forEach((w) => next.delete(w.name));
        return next;
      }
      const next = new Set(prev);
      visibleWos.forEach((w) => next.add(w.name));
      return next;
    });
  };

  const toggleExpand = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const clearFilters = () => {
    setFrom("");
    setTo("");
    setFarm(ALL);
    setGreenhouse(ALL);
  };

  // ── Bulk approve / stop ───────────────────────────────────────────
  const runApproval = async (woNames: string[]) => {
    setBusy(true);
    setProgress({
      open: true,
      title: `Approving ${woNames.length} spray plan${woNames.length !== 1 ? "s" : ""}...`,
      fillPct: 0,
      isStop: false,
      closable: false,
      log: [],
      qrLabels: [],
    });
    let ok = 0;
    let err = 0;
    const qr: QrLabel[] = [];

    for (let i = 0; i < woNames.length; i++) {
      const name = woNames[i];
      try {
        const res: ApproveResult = await approveWorkOrder(name);
        if (res.status === "approved") {
          ok++;
          if (res.qr_labels) {
            res.qr_labels.forEach((l) => qr.push({ ...l, wo: name }));
          }
          appendLog(
            `✓ ${name} — SE ${res.se} raised to ${res.warehouse || "WIP"}` +
              (res.qr_labels?.length
                ? ` · ${res.qr_labels.length} QR label${res.qr_labels.length > 1 ? "s" : ""}`
                : ""),
            "ok",
          );
        } else if (res.status === "already_forwarded") {
          ok++;
          appendLog(`ℹ ${name} — ${res.message || "Already forwarded."}`, "warn");
        } else if (res.status === "skipped") {
          appendLog(`— ${name} — ${res.message || "Skipped."}`, "skip");
        } else {
          err++;
          appendLog(`✗ ${name} — ${res.message || "Unknown error."}`, "err");
        }
      } catch (e: any) {
        err++;
        appendLog(`✗ ${name} — ${e?.message || "Could not connect to server."}`, "err");
      }
      const pct = Math.round(((i + 1) / woNames.length) * 100);
      setProgress((p) => ({ ...p, fillPct: pct }));
    }

    const color =
      err === 0 ? "#10b981" : err === woNames.length ? "#ef4444" : "#f59e0b";
    setProgress((p) => ({
      ...p,
      title: `Done — ${ok} approved, ${err} failed.`,
      fillPct: 100,
      doneColor: color,
      closable: true,
      qrLabels: qr,
    }));
    setBusy(false);
    // Reload to show new forwarded status. Small delay so the user can
    // glance at the summary first.
    window.setTimeout(() => void reload(), 800);
  };

  const runStop = async (woNames: string[]) => {
    setBusy(true);
    setProgress({
      open: true,
      title: `Rejecting ${woNames.length} spray plan${woNames.length !== 1 ? "s" : ""}...`,
      fillPct: 0,
      isStop: true,
      closable: false,
      log: [],
      qrLabels: [],
    });
    let ok = 0;
    let err = 0;

    for (let i = 0; i < woNames.length; i++) {
      const name = woNames[i];
      try {
        const res = await stopWorkOrder(name);
        if (res.status === "stopped") {
          ok++;
          appendLog(`■ ${name} — rejected.`, "warn");
        } else {
          err++;
          appendLog(`✗ ${name} — ${res.message || "Failed."}`, "err");
        }
      } catch (e: any) {
        err++;
        appendLog(`✗ ${name} — ${e?.message || "Could not connect to server."}`, "err");
      }
      const pct = Math.round(((i + 1) / woNames.length) * 100);
      setProgress((p) => ({ ...p, fillPct: pct }));
    }

    const color = err === 0 ? "#ef4444" : err === woNames.length ? "#ef4444" : "#f59e0b";
    setProgress((p) => ({
      ...p,
      title: `Done — ${ok} rejected, ${err} failed.`,
      fillPct: 100,
      doneColor: color,
      closable: true,
    }));
    setBusy(false);
    window.setTimeout(() => void reload(), 800);
  };

  const appendLog = (text: string, variant: LogLine["variant"]) => {
    setProgress((p) => ({ ...p, log: [...p.log, { text, variant }] }));
  };

  const onApproveSelected = () => {
    if (busy) return;
    const names = Array.from(checked);
    if (!names.length) return;
    void runApproval(names);
  };

  const bulkApprove = async () => {
    if (!checked.size) return;
    setBulkBusy(true);
    try {
      const result = await approveDraftsBulk(Array.from(checked));
      appendLog(
        `✓ Bulk approved ${result.approved.length}` +
          (result.skipped.length
            ? ` · ${result.skipped.length} skipped`
            : "") +
          ".",
        "ok",
      );
      setProgress((p) => ({
        ...p,
        open: true,
        title: `Approved ${result.approved.length}${result.skipped.length ? ` · ${result.skipped.length} skipped` : ""}.`,
        fillPct: 100,
        doneColor: "#10b981",
        closable: true,
      }));
      setChecked(new Set());
      window.setTimeout(() => void reload(), 800);
    } catch (e: any) {
      setProgress({
        open: true,
        title: "Bulk approve failed",
        fillPct: 100,
        isStop: false,
        doneColor: "#ef4444",
        closable: true,
        log: [{ text: e?.message || String(e), variant: "err" }],
        qrLabels: [],
      });
    } finally {
      setBulkBusy(false);
    }
  };

  const onStopSelected = () => {
    setStopConfirm(true);
  };

  const confirmStop = () => {
    setStopConfirm(false);
    if (busy) return;
    const names = Array.from(checked);
    if (!names.length) return;
    void runStop(names);
  };

  const closeProgress = () =>
    setProgress((p) => (p.closable ? INITIAL_PROGRESS : p));

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Spray Plan Approval
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Pending application work orders · review and approve in bulk
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {pendingCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 text-amber-600 px-2.5 py-1 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                {pendingCount} pending
              </span>
            )}
            {forwardedCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-600 px-2.5 py-1 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {forwardedCount} forwarded
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label>From</Label>
            <DatePicker value={from} onChange={setFrom} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>To</Label>
            <DatePicker value={to} onChange={setTo} />
          </div>
          <div className="flex flex-col gap-1 min-w-32">
            <Label>Farm</Label>
            <Select value={farm} onValueChange={setFarm}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All Farms</SelectItem>
                {farmsData.farms.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 min-w-40">
            <Label>Greenhouse</Label>
            <Select
              value={greenhouse}
              onValueChange={setGreenhouse}
              disabled={farm === ALL}
            >
              <SelectTrigger className="h-9">
                <SelectValue
                  placeholder={farm === ALL ? "Pick a farm first" : "All"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All</SelectItem>
                {ghOptions.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={clearFilters}
          >
            Clear
          </Button>
        </div>
      </header>

      <div className="px-4 md:px-6 py-4 flex-1 flex flex-col gap-3">
        <Tabs
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
        >
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="pending">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 mr-1.5" />
              Pending · {pendingCount}
            </TabsTrigger>
            <TabsTrigger value="forwarded">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5" />
              Forwarded · {forwardedCount}
            </TabsTrigger>
            {STAGE_TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key}>
                {t.label} · {stageCounts[t.key] || 0}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {errorMsg && (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="p-4 text-sm text-destructive">
              {errorMsg}
            </CardContent>
          </Card>
        )}

        {!isStageTab && !errorMsg && !visibleWos.length && !loading && (
          <Card>
            <CardContent className="p-10 flex flex-col items-center gap-3 text-sm text-muted-foreground">
              <p>
                {statusFilter === "pending"
                  ? "No pending spray plans — all have been forwarded."
                  : "No forwarded plans in this selection."}
              </p>
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Show All Dates
              </Button>
            </CardContent>
          </Card>
        )}

        {isStageTab && !errorMsg && (
          <StageTable
            rows={stageRows}
            loading={loading}
            expanded={stageExpanded}
            onToggle={(name) =>
              setStageExpanded((prev) => (prev === name ? null : name))
            }
          />
        )}

        {!isStageTab && !errorMsg && visibleWos.length > 0 && (
          <Card className="p-0">
            <CardContent className="p-0">
              <div className="flex items-center gap-2 px-3 py-2 border-b text-xs">
                <Checkbox
                  checked={allChecked || (someChecked ? "indeterminate" : false)}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
                <span className="text-muted-foreground">
                  {visibleWos.length} work order
                  {visibleWos.length !== 1 ? "s" : ""}
                </span>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Work Order</TableHead>
                    <TableHead>Greenhouse</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Chems</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleWos.map((w) => {
                    const isChecked = checked.has(w.name);
                    const isOpen = expanded.has(w.name);
                    const created = w.creation
                      ? new Date(w.creation).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })
                      : "—";
                    return (
                      <Fragment key={w.name}>
                        <TableRow
                          className={cn(
                            isChecked && "bg-primary/5",
                            "cursor-pointer",
                          )}
                          onClick={(e) => {
                            const t = e.target as HTMLElement;
                            if (
                              t.closest("a") ||
                              t.closest("button") ||
                              t.closest('[role="checkbox"]')
                            )
                              return;
                            toggleRow(w.name);
                          }}
                        >
                          <TableCell>
                            <Checkbox
                              checked={isChecked}
                              onCheckedChange={() => toggleRow(w.name)}
                              aria-label={`Select ${w.name}`}
                            />
                          </TableCell>
                          <TableCell className="text-xs">
                            <a
                              href={`/app/work-order/${encodeURIComponent(w.name)}`}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium hover:underline"
                            >
                              {w.name}
                            </a>
                          </TableCell>
                          <TableCell className="text-xs">
                            {w.custom_greenhouse || "—"}
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">
                            <span className="rounded bg-muted px-1.5 py-0.5">
                              {created}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs">
                            {w.custom_spray_type ? (
                              <Badge variant="outline" className="text-[0.65rem]">
                                {w.custom_spray_type}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-right tabular-nums">
                            {(w.required_items || []).length}
                          </TableCell>
                          <TableCell>
                            {w.is_forwarded ? (
                              <Badge className="bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/15 text-[0.6rem]">
                                Forwarded
                              </Badge>
                            ) : (
                              <Badge className="bg-amber-500/15 text-amber-600 hover:bg-amber-500/15 text-[0.6rem]">
                                Pending
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(w.name);
                              }}
                            >
                              <ChevronDown
                                className={cn(
                                  "h-4 w-4 transition-transform",
                                  isOpen && "rotate-180",
                                )}
                              />
                            </Button>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell colSpan={8} className="p-0">
                              <ApprovalChemicalsTable woName={w.name} />
                              <div className="p-4 flex flex-col gap-4">
                                <DetailPanel wo={w} />
                                <Separator />
                                <LifecycleTimelineFor workOrder={w.name} />
                              </div>
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

      {/* Sticky action bar */}
      {checked.size > 0 && (
        <div className="sticky bottom-0 z-30 border-t bg-card/95 backdrop-blur px-4 md:px-6 py-3 flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{checked.size}</span>{" "}
            selected
          </div>
          <div className="flex items-center gap-2">
            {stopConfirm && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  Reject {checked.size} plan{checked.size !== 1 ? "s" : ""}? This
                  cannot be undone.
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7"
                  onClick={confirmStop}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => setStopConfirm(false)}
                >
                  Cancel
                </Button>
              </div>
            )}
            {!stopConfirm && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-destructive hover:text-destructive"
                  disabled={busy || bulkBusy}
                  onClick={onStopSelected}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Reject Selected
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={busy || bulkBusy}
                  onClick={() => void bulkApprove()}
                  title="Fast approve — raises draft Stock Entries without streaming progress"
                >
                  {bulkBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Quick Approve
                </Button>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={busy || bulkBusy}
                  onClick={onApproveSelected}
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Approve Selected
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Progress dialog */}
      <ProgressDialog progress={progress} onClose={closeProgress} />

      <LoadingStrip active={loading} />
    </div>
  );
}

// ── Detail panel (expanded row) ─────────────────────────────────────
function DetailPanel({ wo }: { wo: PendingWorkOrder }) {
  const scope = [wo.custom_scope, wo.custom_scope_details]
    .filter(Boolean)
    .join(" — ");
  const created = wo.creation
    ? new Date(wo.creation).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
  const fields: Array<[string, string]> = [
    ["Scope", scope || "—"],
    ["Area", wo.custom_area ? `${wo.custom_area} Ha` : "—"],
    ["Water Volume", wo.custom_water_volume ? `${wo.custom_water_volume} L` : "—"],
    ["Water pH", wo.custom_water_ph ? String(wo.custom_water_ph) : "—"],
    [
      "Hardness",
      wo.custom_water_hardness ? `${wo.custom_water_hardness} ppm` : "—",
    ],
    ["Kit", wo.custom_kit || "—"],
    ["CSU / WIP", wo.wip_warehouse || "—"],
    ["Created", created],
  ];
  const items = wo.required_items || [];
  const targets = parseTargets(wo.custom_targets);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {fields.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground font-medium">
              {k}
            </span>
            <span className="text-xs font-medium">{v}</span>
          </div>
        ))}
      </div>

      {items.length > 0 && (
        <div>
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground font-medium mb-2">
            Chemicals ({items.length})
          </div>
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item Name</TableHead>
                  <TableHead>Item Code</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>UoM</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((it, i) => (
                  <TableRow key={`${it.item_code}-${i}`}>
                    <TableCell className="text-xs">
                      {it.item_name || it.item_code}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {it.item_code}
                    </TableCell>
                    <TableCell className="text-xs text-right font-semibold tabular-nums">
                      {formatQty(it.required_qty)}
                    </TableCell>
                    <TableCell className="text-xs">{it.stock_uom || ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {targets.length > 0 && (
        <div>
          <div className="text-[0.65rem] uppercase tracking-wide text-muted-foreground font-medium mb-2">
            Targets
          </div>
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t) => (
              <Badge key={t} variant="outline" className="text-[0.65rem]">
                {t}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Stage table (post-approval lifecycle tabs) ─────────────────────
function StageTable({
  rows,
  loading,
  expanded,
  onToggle,
}: {
  rows: LifecycleSummaryRow[];
  loading: boolean;
  expanded: string | null;
  onToggle: (name: string) => void;
}) {
  if (!rows.length && !loading) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          No plans at this stage in the current selection.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="p-0">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Work Order</TableHead>
              <TableHead>Greenhouse</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Scheduled</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const open = expanded === r.name;
              return (
                <Fragment key={r.name}>
                  <TableRow className="cursor-pointer" onClick={() => onToggle(r.name)}>
                    <TableCell className="text-xs font-medium">
                      <a
                        href={`/app/work-order/${encodeURIComponent(r.name)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.name}
                      </a>
                    </TableCell>
                    <TableCell className="text-xs">{r.greenhouse || "—"}</TableCell>
                    <TableCell className="text-xs">
                      {r.spray_type ? (
                        <Badge variant="outline" className="text-[0.65rem]">
                          {r.spray_type}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      <div className="flex items-center gap-2">
                        {r.scheduled ? r.scheduled.slice(0, 16) : "—"}
                        {r.missed && (
                          <span className="inline-flex items-center gap-1 text-[0.6rem] font-medium text-[var(--sd-data-red)]">
                            <XCircle className="h-3 w-3" />
                            Missed
                          </span>
                        )}
                      </div>
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
                        <LifecycleTimelineFor workOrder={r.name} />
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
  );
}

// ── Progress dialog ────────────────────────────────────────────────
function ProgressDialog({
  progress,
  onClose,
}: {
  progress: ProgressState;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={progress.open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle
            style={progress.doneColor ? { color: progress.doneColor } : undefined}
          >
            {progress.title}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                progress.isStop ? "bg-red-500" : "bg-emerald-500",
              )}
              style={{ width: `${progress.fillPct}%` }}
            />
          </div>
          <div className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-xs font-mono space-y-0.5">
            {progress.log.map((l, i) => (
              <div
                key={i}
                className={cn(
                  l.variant === "ok" && "text-emerald-600",
                  l.variant === "warn" && "text-amber-600",
                  l.variant === "skip" && "text-muted-foreground",
                  l.variant === "err" && "text-red-600",
                )}
              >
                {l.text}
              </div>
            ))}
            {!progress.log.length && (
              <div className="text-muted-foreground">Working...</div>
            )}
          </div>
          {progress.qrLabels.length > 0 && (
            <QrSection labels={progress.qrLabels} />
          )}
          {progress.closable && (
            <div className="flex justify-end">
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── QR section + print window ──────────────────────────────────────
function QrSection({ labels }: { labels: QrLabel[] }) {
  const print = () => openQrPrintWindow(labels);
  const preview = labels.slice(0, 8);
  return (
    <div className="rounded-md border p-3 space-y-2 bg-card">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium">
          {labels.length} QR label{labels.length !== 1 ? "s" : ""} generated
        </div>
        <Button size="sm" className="h-7" onClick={print}>
          <Printer className="h-3.5 w-3.5" />
          Print Labels
        </Button>
      </div>
      <div className="flex gap-2 overflow-auto pb-1">
        {preview.map((l, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded border bg-muted/40 p-1.5 min-w-fit"
          >
            <img
              src={`data:image/png;base64,${l.png_base64}`}
              alt={l.chemical}
              className="h-12 w-12"
              style={{ imageRendering: "pixelated" }}
            />
            <div className="text-[0.7rem]">
              <div className="font-semibold truncate max-w-[12ch]">
                {l.chemical}
              </div>
              <div className="text-muted-foreground">
                {l.qty} {l.uom}
              </div>
            </div>
          </div>
        ))}
        {labels.length > 8 && (
          <div className="self-center text-xs text-muted-foreground px-2">
            +{labels.length - 8} more
          </div>
        )}
      </div>
    </div>
  );
}

/** 25×15 mm minimal QR-only label sheet. One QR per page, no text —
 *  all order context (chemical, qty, WO, farm, etc.) is encoded in the
 *  QR and recovered on scan. */
function openQrPrintWindow(labels: QrLabel[]) {
  const win = window.open("", "_blank", "width=480,height=640");
  if (!win) {
    alert("Pop-ups are blocked. Allow pop-ups for this site to print labels.");
    return;
  }

  const rows = labels
    .map(
      (l) =>
        `<div class="label"><img class="qrimg" src="data:image/png;base64,${l.png_base64}"></div>`,
    )
    .join("");

  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Chemical QR Labels</title>
<style>
@page{size:25mm 15mm;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;background:#e5e7eb;padding:16px}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:14px;padding:10px 14px;background:#1f2937;border-radius:6px;color:#fff}
.toolbar h2{flex:1;font-size:.85rem;font-weight:700}
.toolbar button{padding:6px 14px;border:none;border-radius:5px;font-weight:600;font-size:.72rem;cursor:pointer}
.btn-print{background:#059669;color:#fff}.btn-close{background:#374151;color:#fff}
.sheet{display:flex;flex-direction:column;align-items:center;gap:6px}
.label{width:25mm;height:15mm;background:#fff;border:1px solid #000;display:flex;align-items:center;justify-content:center;overflow:hidden;page-break-after:always}
.label:last-child{page-break-after:auto}
.qrimg{width:13mm;height:13mm;image-rendering:pixelated;display:block}
@media print{body{background:#fff;padding:0}.no-print{display:none!important}.sheet{gap:0}.label{border:none}}
</style></head><body>
<div class="toolbar no-print">
  <h2>Chemical QR Labels — 25×15 mm (${labels.length} label${labels.length !== 1 ? "s" : ""})</h2>
  <button class="btn-print" onclick="window.print()">Print</button>
  <button class="btn-close" onclick="window.close()">Close</button>
</div>
<div class="sheet">${rows}</div>
</body></html>`);
  win.document.close();
}
