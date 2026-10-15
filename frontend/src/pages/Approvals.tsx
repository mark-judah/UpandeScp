/**
 * Spray Plan Approval — direct port of the legacy
 * `www/spray_plan_approval` page into a React route. The legacy page is
 * a bulk-ops console: select multiple Application Floor Plan work
 * orders, approve them in one pass (creating draft Material Transfer
 * Stock Entries + QR labels per chemical) or stop them, with a live
 * progress panel and a 30×40 mm QR print window.
 *
 * Server access is gated to "SCP Spray Plan Approver" / "SCP General Manager" /
 * "System Manager" on the endpoint side
 * (see ``upande_scp/serverscripts/spray_plan_approval.py``);
 * non-privileged users will still see the route but every API call
 * fails with PermissionError, which we surface as an error state.
 */

import { useToast } from "@/components/Toast";
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { ChevronDown } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { PageHeader } from "@/components/PageHeader";
import { PlacePicker } from "@/components/PlacePicker";
import { TogglePill } from "@/components/TogglePill";
import { ClearFiltersPill } from "@/components/ClearFiltersPill";
import { StalePlansTab } from "@/components/spray-plan/StalePlansTab";
import { ApprovalActionBar } from "@/components/spray-plan/ApprovalActionBar";
import { ApprovedList, ApprovedStepFilter, PlanCount, filterApproved, isApprovedRow } from "@/components/spray-plan/ApprovedList";
import { HEADER_PILL } from "@/components/header-controls";
import { DateRangePicker } from "@/components/DateRangePicker";
import {
  DATE_BASIS_LABEL,
  dateBasisHint,
  groupByFarm,
  type DateBasis,
} from "@/lib/approval-grouping";
import { LoadingStrip } from "@/components/LoadingStrip";
import { TableRowsSkeleton, TextSkeleton, firstLoad } from "@/components/Loading";
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
} from "@/lib/spray-plan-api";
import { approveDraftsBulk } from "@/lib/spray-plan-creator-api";
import { ApprovalChemicalsTable } from "@/components/spray-plan/ApprovalChemicalsTable";
import { LifecycleTimelineFor } from "@/components/spray-plan/LifecycleTimeline";
import {
  fetchLifecycleSummary,
  type LifecycleSummaryRow,
} from "@/lib/lifecycle-api";

import { errorText } from "@/lib/errors";
import { TargetPills } from "@/components/spray-plan/TargetPills";
import { useLiveApprovals } from "@/hooks/use-live-approvals";
import {
  EMPTY_FEED,
  keepSelection,
  mergeFeed,
  newPlansMessage,
  type FeedState,
} from "@/lib/approval-live";
import { DEFAULT_CROP } from "@/lib/scouting-api";
const ALL = "__all__";
type Tab = "pending" | "approved" | "stale";

function defaultRange(): { from: string; to: string } {
  // Legacy default = today / today.
  const t = ymd(new Date());
  return { from: t, to: t };
}

export function Approvals({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const toast = useToast();
  const [from, setFrom] = useState(defaultRange().from);
  const [to, setTo] = useState(defaultRange().to);
  const [farm, setFarm] = useState<string>(ALL);
  const [greenhouse, setGreenhouse] = useState<string>(ALL);
  const [farmsData, setFarmsData] = useState<FarmsAndGreenhouses>({
    farms: [],
    greenhouses_by_farm: {},
  });
  const [feed, setFeed] = useState<FeedState>(EMPTY_FEED);
  const allWos = feed.wos;
  // Plans that arrived while the page was open: they carry a "New" pill until
  // the approver selects or opens them (or changes the filters).
  const freshNames = feed.fresh;
  const feedRef = useRef(feed);
  feedRef.current = feed;
  // Only the newest request may write: a slow poll must not overwrite a filter change.
  const reqRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("pending");
  const [staleCount, setStaleCount] = useState<number | null>(null);
  // Which date the range filters on, and whether to break the list up by farm.
  // Both are the operator's call: an approver clearing a desk works by arrival,
  // a farm manager works a farm at a time, and neither is right for everyone.
  const [dateBasis, setDateBasis] = useState<DateBasis>("scheduled");
  const [groupFarms, setGroupFarms] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [summary, setSummary] = useState<LifecycleSummaryRow[]>([]);
  // The lists start empty, so "has data" is "a response has landed" — one flag
  // per feed, since the stage summary arrives after the approval list.
  const [loaded, setLoaded] = useState(false);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const reloadTimerRef = useRef<number | null>(null);

  // ── Data loading ──────────────────────────────────────────────────
  useEffect(() => {
    fetchFarmsAndGreenhouses()
      .then(setFarmsData)
      .catch(() => {});
  }, []);

  const reload = useCallback(async (quiet = false) => {
    // A quiet (live) refresh keeps the list, selection, expansion and scroll
    // exactly as they are; only a filter change or an action starts over.
    const req = ++reqRef.current;
    if (!quiet) {
      setLoading(true);
      setErrorMsg(null);
    }
    try {
      const r = await fetchPendingWorkOrders({
        from_date: from || null,
        to_date: to || null,
        farm: farm === ALL ? null : farm,
        greenhouse: greenhouse === ALL ? null : greenhouse,
        date_basis: dateBasis,
      });
      if (req !== reqRef.current) return;
      const { state, added } = mergeFeed(
        quiet ? feedRef.current : EMPTY_FEED,
        r.work_orders || [],
        quiet,
      );
      setFeed(state);
      setLoaded(true);
      if (quiet) {
        setChecked((prev) => keepSelection(prev, state.wos));
        if (added.length) {
          toast.show(
            newPlansMessage(
              added.length,
              added.map((w) => dateBasis === "created" ? String(w.creation || "").slice(0, 10) : String(w.custom_scheduled_application_time || w.planned_start_date || "").slice(0, 10)),
            ),
            "info",
          );
        }
      } else {
        setChecked(new Set());
        setExpanded(new Set());
      }
      // Post-approval stages come from the lifecycle summary. Best-effort —
      // a failure just leaves the stage tabs empty, it doesn't break approvals.
      fetchLifecycleSummary({
        from_date: from || undefined,
        to_date: to || undefined,
        farm: farm === ALL ? undefined : farm,
        greenhouse: greenhouse === ALL ? undefined : greenhouse,
      })
        .then(setSummary)
        .catch(() => setSummary([]))
        .finally(() => setSummaryLoaded(true));
    } catch (e: any) {
      if (quiet || req !== reqRef.current) return; // a failed live refresh keeps what is shown
      setFeed(EMPTY_FEED);
      setErrorMsg(
        e?.message?.includes("permission")
          ? "You do not have permission to view spray plan approvals. Ask an admin for the Spray Plan Approver role."
          : "Failed to load work orders. Check your connection or permissions.",
      );
    } finally {
      if (!quiet && req === reqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, farm, greenhouse, dateBasis]);

  // Live: a spray plan event for these dates / this place, a 30 s poll while the
  // socket is down, and a refresh on window focus.
  useLiveApprovals(
    { from, to, dateBasis, farm: farm === ALL ? "" : farm, greenhouse: greenhouse === ALL ? "" : greenhouse },
    () => void reload(true),
  );
  const dismissFresh = (name: string) =>
    setFeed((f) => {
      if (!f.fresh.has(name)) return f;
      const fresh = new Set(f.fresh);
      fresh.delete(name);
      return { ...f, fresh };
    });

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

  // ── Derived ───────────────────────────────────────────────────────
  // First load only: a filter change keeps the old list on screen (with the
  // LoadingStrip) instead of blanking it into skeletons.
  const skeleton = firstLoad(loading, loaded);
  const stageSkeleton = !summaryLoaded && !errorMsg;
  const pendingCount = useMemo(
    () => allWos.filter((w) => !w.is_forwarded).length,
    [allWos],
  );
  const [approvedStep, setApprovedStep] = useState("");
  const approvedShown = useMemo(() => filterApproved(summary, approvedStep).length, [summary, approvedStep]);
  const approvedCount = useMemo(() => summary.filter(isApprovedRow).length, [summary]);

  // The pending table is the approval feed's not-yet-forwarded plans.
  const visibleWos = useMemo(
    () => (tab === "pending" ? allWos.filter((w) => !w.is_forwarded) : []),
    [allWos, tab],
  );

  const farmGroups = useMemo(
    () => (groupFarms ? groupByFarm(visibleWos) : []),
    [groupFarms, visibleWos],
  );

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

  // farm → greenhouses for the place picker.
  const placeFarms = useMemo(
    () => Object.fromEntries(farmsData.farms.map((f) => [f, farmsData.greenhouses_by_farm[f] || []])),
    [farmsData],
  );

  const allChecked =
    visibleWos.length > 0 && visibleWos.every((w) => checked.has(w.name));
  const someChecked =
    visibleWos.some((w) => checked.has(w.name)) && !allChecked;

  // ── Selection actions ─────────────────────────────────────────────
  const toggleRow = (name: string) => {
    dismissFresh(name);
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
    dismissFresh(name);
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
  // Progress is a quiet "loading" toast; the outcome is one toast in the tone
  // it deserves (green when everything went through). Anything the approver
  // must read twice — blocked or failed plans — rides in the hint.
  const reportOutcome = (
    lead: string,
    ok: number,
    notes: { blocked: string[]; failed: string[]; skipped: string[] },
  ) => {
    const problems = notes.blocked.length + notes.failed.length + notes.skipped.length;
    const hint = problems
      ? [...notes.blocked, ...notes.failed, ...notes.skipped].slice(0, 3).join(" · ") +
        (problems > 3 ? ` · and ${problems - 3} more` : "")
      : undefined;
    const kind = notes.failed.length && !ok ? "err" : problems ? "warn" : "ok";
    toast.show(lead, kind, hint ? { hint } : undefined);
  };

  const runApproval = async (woNames: string[]) => {
    setBusy(true);
    const loadingId = toast.show(
      `Approving ${woNames.length} spray plan${woNames.length !== 1 ? "s" : ""}…`,
      "loading",
    );
    let ok = 0;
    const notes = { blocked: [] as string[], failed: [] as string[], skipped: [] as string[] };
    for (const name of woNames) {
      try {
        const res: ApproveResult = await approveWorkOrder(name);
        if (res.status === "approved" || res.status === "already_forwarded") {
          ok++;
        } else if (res.status === "skipped") {
          notes.skipped.push(`${name} skipped`);
        } else if (res.status === "blocked") {
          // Not a failure: held until its spray check passes or a GM overrides it.
          notes.blocked.push(`${name} blocked by spray check`);
        } else {
          notes.failed.push(`${name}: ${res.message || "unknown error"}`);
        }
      } catch (e: any) {
        notes.failed.push(`${name}: ${errorText(e, "could not connect to server")}`);
      }
    }
    toast.dismiss(loadingId);
    reportOutcome(`${ok} spray plan${ok !== 1 ? "s" : ""} approved.`, ok, notes);
    setBusy(false);
    window.setTimeout(() => void reload(), 500);
  };

  const runStop = async (woNames: string[]) => {
    setBusy(true);
    const loadingId = toast.show(
      `Stopping ${woNames.length} work order${woNames.length !== 1 ? "s" : ""}…`,
      "loading",
    );
    let ok = 0;
    const notes = { blocked: [] as string[], failed: [] as string[], skipped: [] as string[] };
    for (const name of woNames) {
      try {
        const res = await stopWorkOrder(name);
        if (res.status === "stopped") ok++;
        else notes.failed.push(`${name}: ${res.message || "failed"}`);
      } catch (e: any) {
        notes.failed.push(`${name}: ${errorText(e, "could not connect to server")}`);
      }
    }
    toast.dismiss(loadingId);
    reportOutcome(`${ok} work order${ok !== 1 ? "s" : ""} stopped.`, ok, notes);
    setBusy(false);
    window.setTimeout(() => void reload(), 500);
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
      const SPRAY_BLOCK = "blocked by spray check: ";
      const blocked = result.skipped
        .filter((sk) => sk.reason.startsWith(SPRAY_BLOCK))
        .map((sk) => `${sk.name} blocked by spray check`);
      const skipped = result.skipped
        .filter((sk) => !sk.reason.startsWith(SPRAY_BLOCK))
        .map((sk) => `${sk.name}: ${sk.reason}`);
      const n = result.approved.length;
      reportOutcome(`${n} spray plan${n !== 1 ? "s" : ""} approved.`, n, { blocked, failed: [], skipped });
      setChecked(new Set());
      window.setTimeout(() => void reload(), 500);
    } catch (e: any) {
      toast.show("Bulk approve failed.", "err", { hint: errorText(e) });
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

  // ── Render ────────────────────────────────────────────────────────
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex flex-col min-h-svh">
      <PageHeader
        title="Spray Plan Approval"
        eyebrow="Pending application work orders · review and approve in bulk"
        switcher={
          <TabsList className="flex-wrap h-auto">
                <TabsTrigger value="pending">
                  Pending · {skeleton ? <TextSkeleton width="1.5ch" /> : pendingCount}
                </TabsTrigger>
                <TabsTrigger value="approved">
                  Approved · {stageSkeleton ? <TextSkeleton width="1.5ch" /> : approvedCount}
                </TabsTrigger>
                <TabsTrigger value="stale">
                  Stale · {staleCount === null ? <TextSkeleton width="1.5ch" /> : staleCount}
                </TabsTrigger>
              </TabsList>
        }
        tab={tab}
        filters={[
          { key: "date-basis", tabs: ["pending"], node: (
        <Select
          value={dateBasis}
          onValueChange={(v) => setDateBasis(v as DateBasis)}
        >
          <SelectTrigger aria-label="Filter dates by" className={HEADER_PILL}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="scheduled">{DATE_BASIS_LABEL.scheduled}</SelectItem>
            <SelectItem value="created">{DATE_BASIS_LABEL.created}</SelectItem>
          </SelectContent>
        </Select>
          ) },
          { key: "date-range", tabs: ["pending"], node: (
        <DateRangePicker
          value={{ from, to }}
          onChange={({ from: f, to: t }) => {
            setFrom(f);
            setTo(t);
          }}
          label="Date range"
        />
          ) },
          { key: "group-farms", tabs: ["pending"], node: (
        <TogglePill
          pressed={groupFarms}
          onPressedChange={setGroupFarms}
          title="Break the list into one section per farm"
        >
          Group by farm
        </TogglePill>
          ) },
          { key: "place", node: (
        <PlacePicker
          farms={placeFarms}
          value={{ farm: farm === ALL ? "" : farm, greenhouse: greenhouse === ALL ? "" : greenhouse }}
          onChange={(p) => {
            setFarm(p.farm || ALL);
            setGreenhouse(p.greenhouse || ALL);
          }}
          disabled={!farmsData.farms.length}
        />
          ) },
          { key: "approved-step", tabs: ["approved"], node: (
            <ApprovedStepFilter step={approvedStep} onChange={setApprovedStep} />
          ) },
          { key: "approved-count", tabs: ["approved"], node: <PlanCount n={approvedShown} /> },
        ]}
      >
        <ClearFiltersPill
          active={Boolean(from || to || farm !== ALL || greenhouse !== ALL)}
          onClear={clearFilters}
        />
      </PageHeader>

      <div
        className="px-4 md:px-6 py-4 flex-1 flex flex-col gap-3"
        aria-busy={loading || undefined}
      >

        {errorMsg && (
          <Card className="border-destructive/40 bg-destructive/5">
            <CardContent className="p-4 text-sm text-destructive">
              {errorMsg}
            </CardContent>
          </Card>
        )}

        {/* Always mounted so the tab can show its count; hidden off its tab. */}
        <div hidden={tab !== "stale"}>
          <StalePlansTab
            farm={farm === ALL ? undefined : farm}
            crop={crop}
            onCount={setStaleCount}
          />
        </div>

        {tab === "pending" && !errorMsg && !visibleWos.length && !loading && (
          <Card>
            <CardContent className="p-10 flex flex-col items-center gap-3 text-sm text-muted-foreground">
              <p>No pending spray plans — all have been forwarded.</p>
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Show All Dates
              </Button>
            </CardContent>
          </Card>
        )}

        {tab === "approved" && !errorMsg && (
          <ApprovedList rows={summary} loading={stageSkeleton} step={approvedStep} />
        )}

        {tab === "pending" && !errorMsg && (visibleWos.length > 0 || skeleton) && (
          <Card className="p-0">
            <CardContent className="p-0">
              <div className="flex items-center gap-2 px-3 py-2 border-b text-xs">
                <Checkbox
                  checked={allChecked || (someChecked ? "indeterminate" : false)}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
                <span className="text-muted-foreground">
                  {skeleton ? (
                    <TextSkeleton width="7rem" />
                  ) : (
                    <>
                      {visibleWos.length} work order
                      {visibleWos.length !== 1 ? "s" : ""}
                    </>
                  )}
                </span>
                {/* Which of the two dates the range is filtering on. The page
                    used to answer only "scheduled for", which is why a range
                    covering today could come back empty while plans waited. */}
                <span className="text-muted-foreground/70 truncate">
                  · {dateBasisHint(dateBasis)}
                </span>
                {groupFarms && farmGroups.length > 0 ? (
                  <span className="text-muted-foreground/70">
                    · {farmGroups.length} farm{farmGroups.length !== 1 ? "s" : ""}
                  </span>
                ) : null}
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10" />
                    <TableHead>Work Order</TableHead>
                    <TableHead>Greenhouse</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Chems</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {skeleton && <TableRowsSkeleton cols={8} rows={8} />}
                  {(groupFarms
                    ? farmGroups.flatMap((g) =>
                        g.plans.map((p, i) => ({ ...p, __farmHead: i === 0 ? g : null })),
                      )
                    : visibleWos.map((w) => ({ ...w, __farmHead: null }))
                  ).map((w: any) => {
                    const isChecked = checked.has(w.name);
                    const isOpen = expanded.has(w.name);
                    const sched = w.custom_scheduled_application_time
                      ? w.custom_scheduled_application_time.split(" ")[0]
                      : "—";
                    return (
                      <Fragment key={w.name}>
                        {/* One heading per farm when grouping is on, so an
                            approver can work a farm at a time instead of
                            reading a mixed list. */}
                        {w.__farmHead ? (
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={8} className="py-1.5">
                              <span className="text-xs font-medium">
                                {w.__farmHead.farm}
                              </span>
                              <span className="text-[0.7rem] text-muted-foreground ml-2">
                                {w.__farmHead.plans.length} plan
                                {w.__farmHead.plans.length !== 1 ? "s" : ""}
                              </span>
                            </TableCell>
                          </TableRow>
                        ) : null}
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
                            {freshNames.has(w.name) && (
                              <span
                                data-testid="new-pill"
                                className="ml-2 rounded-full bg-primary/10 px-1.5 py-px text-[0.6rem] font-medium leading-none text-primary"
                              >
                                New
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {w.custom_greenhouse || "—"}
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">
                            <span className="rounded bg-muted px-1.5 py-0.5">
                              {sched}
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
                                <DetailPanel wo={w} crop={crop} />
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

      <ApprovalActionBar
        count={checked.size}
        busy={busy}
        bulkBusy={bulkBusy}
        stopConfirm={stopConfirm}
        onApprove={onApproveSelected}
        onQuick={() => void bulkApprove()}
        onStop={onStopSelected}
        onConfirmStop={confirmStop}
        onCancelStop={() => setStopConfirm(false)}
      />

      <LoadingStrip active={loading} />
    </Tabs>
  );
}

// ── Detail panel (expanded row) ─────────────────────────────────────
function DetailPanel({ wo, crop }: { wo: PendingWorkOrder; crop: string }) {
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
          <TargetPills
            targets={targets}
            greenhouse={wo.custom_greenhouse}
            crop={crop}
            toDate={String(wo.custom_scheduled_application_time || wo.planned_start_date || "").slice(0, 10) || undefined}
          />
        </div>
      )}
    </div>
  );
}
