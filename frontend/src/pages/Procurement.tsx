/**
 * Chemical procurement — requirements, review, one order, apportioned split.
 *
 * One page for three jobs because they are three views of the same documents:
 *
 * * a **planner** states their farm's requirement, and once it has been reviewed
 *   can only change it by requesting an amendment;
 * * the **GM** sees consolidated totals, makes the financial call per chemical,
 *   raises one Material Request, then splits the receipt back to the farms;
 * * the **general store keeper** sees what is left in the pool, who is owed it,
 *   and decides who may draw on it.
 *
 * Two rules the UI has to make visible rather than merely obey:
 *
 * * a figure marked final is shown locked, not just refused on save — the GM
 *   should see the commitment before trying to move it;
 * * a carried credit is shown wherever a quantity is, because "your farm is owed
 *   0.4 from last cycle" is the difference between the split looking arbitrary
 *   and looking correct.
 */
import { DateRangePicker } from "@/components/DateRangePicker";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Bar, RowsSkeleton, TableRowsSkeleton, TextSkeleton } from "@/components/Loading";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileText,
  Lock,
  Plus,
  RefreshCw,
  Scale,
  Send,
  Trash2,
  Warehouse,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
import { PlacePicker } from "@/components/PlacePicker";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast, type ToastItem } from "@/components/Toast";
import { cn } from "@/lib/utils";
import { bootstrap, FrappeError } from "@/lib/frappe";
import { errorText } from "@/lib/errors";
import { fmtQty } from "@/lib/uom";
import { searchChemicalItems, type ChemicalItem } from "@/lib/scouting-api";
import { FarmBreakdown } from "@/components/procurement/FarmBreakdown";
import { InsightLine, insightState } from "@/components/procurement/InsightLine";
import {
  companiesForCycle,
  consolidateCycle,
  consumptionVsAllocation,
  createCycle,
  createMaterialRequest,
  cycleMoney,
  type CycleMoney,
  decideAmendment,
  decidePoolRequest,
  describeCredit,
  describeRequirement,
  fetchInsights,
  finaliseLine,
  getCycle,
  itemBreakdown,
  type FarmInsights,
  type ItemBreakdown,
  procurementFarms,
  isEditable,
  listAmendments,
  listCycles,
  listPoolRequests,
  myRequirement,
  poolStatus,
  previewAllocation,
  publishAllocation,
  requestAmendment,
  requestFromPool,
  requirementsFor,
  resolveReduction,
  reviewRequirement,
  saveRequirement,
  setReduction,
  submitRequirement,
  transferAllocation,
  type AllocationMode,
  type AllocationPreviewLine,
  type Amendment,
  type Cycle,
  type CycleDetail,
  type PoolRequest,
  type PoolStatus,
  type ReductionMode,
  type Requirement,
} from "@/lib/procurement-api";

/** The route's crop. Every read passes it so the server scopes cycles and farms to the
 *  companies the crop grows in: a Roses user never gets Kaitet Ltd.'s. */
const CropCtx = createContext<string | undefined>(undefined);

const GM_ROLES = ["SCP General Manager", "System Manager", "Administrator"];
const KEEPER_ROLE = "SCP Chemical Store Keeper";

type TabKey = "requirement" | "review" | "consolidated" | "allocation" | "pool";

interface BasketRow {
  item_code: string;
  item_name: string;
  uom: string;
  qty: string;
  note?: string;
}

function useToasts() {
  const toast = useToast();
  const push = useCallback(
    (text: string, kind: ToastItem["kind"] = "info") => {
      toast.show(text, kind);
    },
    [toast],
  );
  return { push };
}

function errText(e: unknown): string {
  if (e instanceof FrappeError) return e.message;
  return errorText(e);
}

export function Procurement({ initialCrop }: { initialCrop?: string } = {}) {
  const roles = bootstrap().roles || [];
  const isGm = roles.some((r) => GM_ROLES.includes(r));
  const isKeeper = roles.includes(KEEPER_ROLE);

  const { push } = useToasts();
  const [tab, setTab] = useState<TabKey>(isKeeper && !isGm ? "pool" : "requirement");
  const [busy, setBusy] = useState(false);

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cycleId, setCycleId] = useState<string>("");
  const [farms, setFarms] = useState<string[]>([]);
  const [farm, setFarm] = useState<string>("");
  const [newOpen, setNewOpen] = useState(false);
  // Until the cycles land, "No cycle open" would be a guess: the frame is
  // drawn and the cycle, eyebrow and tab body pend.
  const [shellLoaded, setShellLoaded] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  // The farm list is the cycle's company's, so it follows the cycle.
  const [farmsReady, setFarmsReady] = useState(false);

  const loadShell = useCallback(async () => {
    setShellError(null);
    try {
      const cs = await listCycles(undefined, initialCrop);
      setCycles(cs);
      setCycleId((prev) => (prev && cs.some((c) => c.name === prev) ? prev : cs[0]?.name || ""));
    } catch (e) {
      // Not "No cycle open": the cycles could not be read at all.
      setShellError(errText(e));
    } finally {
      setShellLoaded(true);
    }
  }, [initialCrop]);

  useEffect(() => {
    void loadShell();
  }, [loadShell]);

  useEffect(() => {
    if (!shellLoaded) return;
    let alive = true;
    setFarmsReady(false);
    procurementFarms(initialCrop, cycleId || undefined)
      .catch(() => [] as string[])
      .then((fs) => {
        if (!alive) return;
        setFarms(fs);
        setFarm((prev) => (fs.includes(prev) ? prev : fs[0] || ""));
        setFarmsReady(true);
      });
    return () => {
      alive = false;
    };
  }, [shellLoaded, initialCrop, cycleId]);

  const cycle = cycles.find((c) => c.name === cycleId);

  return (
    <CropCtx.Provider value={initialCrop}>
    <div className="flex min-w-0 flex-col gap-4 pb-4 md:pb-6">
      {/* No padding on this wrapper: PageHeader pads itself, and the body below pads
          to match, so the tab bar, title and filters share one left edge. */}
      <PageHeader
        title="Chemical Procurement"
        eyebrow={
          cycle ? (
            `${cycle.cycle_name} · ${cycle.status}`
          ) : shellLoaded && !shellError ? (
            "No cycle open"
          ) : (
            <TextSkeleton width="14ch" />
          )
        }
        switcher={
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <TabsList>
              <TabsTrigger value="requirement">My requirement</TabsTrigger>
              <TabsTrigger value="review">Review</TabsTrigger>
              {isGm && <TabsTrigger value="consolidated">Consolidated</TabsTrigger>}
              {isGm && <TabsTrigger value="allocation">Allocation</TabsTrigger>}
              <TabsTrigger value="pool">General store</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        <HeaderIconButton
          aria-label="Refresh"
          title="Refresh"
          onClick={() => void loadShell()}
        >
          <RefreshCw className="size-4" />
        </HeaderIconButton>
      </PageHeader>

      <div className="flex flex-col gap-4 px-4 md:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={cycleId} onValueChange={setCycleId} disabled={!shellLoaded}>
          <SelectTrigger aria-label="Cycle" className={HEADER_PILL}>
            <SelectValue placeholder="Cycle" />
          </SelectTrigger>
          <SelectContent>
            {cycles.map((c) => (
              <SelectItem key={c.name} value={c.name}>
                {c.cycle_name} — {c.status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isGm && (
          <Button variant="outline" onClick={() => setNewOpen(true)}>
            <Plus className="mr-1 size-4" /> New cycle
          </Button>
        )}
        {/* The planner's farm (place picker G2): always shown once there is a
            farm, a single farm reading as itself; there is no "all" here. */}
        {(!shellLoaded || !farmsReady || farms.length > 0) && (
          <PlacePicker
            level="farm"
            farms={farms}
            allLabel={false}
            value={{ farm, greenhouse: "" }}
            onChange={(p) => setFarm(p.farm)}
            disabled={!shellLoaded || !farmsReady}
          />
        )}
      </div>

      {!shellLoaded || (!farmsReady && tab === "requirement") ? (
        <TableCardSkeleton heads={TAB_HEADS[tab]} />
      ) : shellError && !cycleId ? (
        <LoadFailed message={shellError} onRetry={() => void loadShell()} />
      ) : !cycleId ? (
        <EmptyState
          icon={ClipboardList}
          title="No cycle open"
          detail="The General Manager opens a procurement cycle before farms can state what they need."
        />
      ) : (
        <>
          {tab === "requirement" && (
            <RequirementTab
              cycle={cycleId}
              farm={farm}
              push={push}
              busy={busy}
              setBusy={setBusy}
            />
          )}
          {tab === "review" && (
            <ReviewTab cycle={cycleId} push={push} busy={busy} setBusy={setBusy} />
          )}
          {tab === "consolidated" && isGm && (
            <ConsolidatedTab
              cycle={cycleId}
              push={push}
              busy={busy}
              setBusy={setBusy}
            />
          )}
          {tab === "allocation" && isGm && (
            <AllocationTab cycle={cycleId} push={push} busy={busy} setBusy={setBusy} />
          )}
          {tab === "pool" && (
            <PoolTab
              farm={farm}
              isKeeper={isKeeper || isGm}
              push={push}
              busy={busy}
              setBusy={setBusy}
            />
          )}
        </>
      )}

      {isGm && (
        <NewCycleDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          push={push}
          onCreated={async (name) => {
            await loadShell();
            setCycleId(name);
          }}
        />
      )}
      </div>
    </div>
    </CropCtx.Provider>
  );
}

function EmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: typeof ClipboardList;
  title: string;
  detail: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
        <Icon className="size-8 text-muted-foreground" />
        <p className="font-medium">{title}</p>
        <p className="max-w-md text-sm text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

/** Each tab's main table, by its column headings — drawn while its data (or
 *  the cycle it belongs to) is still on the way. */
const TAB_HEADS: Record<TabKey, string[]> = {
  requirement: ["Chemical", "Quantity", "UOM"],
  review: ["Farm", "Status", "Lines", ""],
  consolidated: ["Chemical", "Requested", "Reduce by", "Value", "Approved", ""],
  allocation: ["Farm", "Requested", "Allocated"],
  pool: ["Chemical", "Farm", "Carried", "Since"],
};

/** A tab whose first load failed: says so, with a retry, instead of pulsing on. */
function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card>
      <CardContent role="alert" className="flex flex-wrap items-center justify-between gap-3 py-4 text-sm">
        <span className="text-destructive">{message}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1 size-4" /> Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function TableCardSkeleton({ heads, rows = 5 }: { heads: string[]; rows?: number }) {
  return (
    <Card aria-busy="true">
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              {heads.map((h, i) => (
                <TableHead key={i}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRowsSkeleton cols={heads.length} rows={rows} />
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── my requirement ────────────────────────────────────────────────────────

function RequirementTab({
  cycle,
  farm,
  push,
  busy,
  setBusy,
}: {
  cycle: string;
  farm: string;
  push: (m: string, v?: ToastItem["kind"]) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const crop = useContext(CropCtx);
  const [req, setReq] = useState<Requirement | null>(null);
  const [rows, setRows] = useState<BasketRow[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChemicalItem[]>([]);
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [amendRows, setAmendRows] = useState<Record<string, string>>({});

  const [reqError, setReqError] = useState<string | null>(null);
  // Another cycle or farm: the previous requirement must not stay on screen
  // (or behind Save / Submit) while this one loads.
  useEffect(() => {
    setReq(null);
    setReqError(null);
  }, [cycle, farm]);

  const load = useCallback(async () => {
    if (!cycle || !farm) return;
    try {
      const r = await myRequirement(cycle, farm, crop);
      setReq(r);
      setReqError(null);
      setRows(
        r.items.map((i) => ({
          item_code: i.item_code,
          item_name: i.item_name || i.item_code,
          uom: i.uom || "",
          qty: String(i.requested_qty),
          note: i.note || undefined,
        })),
      );
    } catch (e) {
      push(errText(e), "err");
      setReqError(errText(e));
    }
  }, [cycle, farm, push, crop]);

  useEffect(() => {
    void load();
  }, [load]);

  // Insights for the chemicals on the list: one batched call per farm, re-asked only
  // when the set of chemicals changes (not on every keystroke in a quantity).
  const [ins, setIns] = useState<{ data?: FarmInsights; loading: boolean; failed: boolean }>({
    loading: false,
    failed: false,
  });
  const codesKey = useMemo(() => rows.map((r) => r.item_code).sort().join("|"), [rows]);
  useEffect(() => {
    setIns({ loading: false, failed: false });
  }, [farm, cycle]);
  useEffect(() => {
    if (!farm || !codesKey) return;
    let alive = true;
    setIns((s) => ({ ...s, loading: true, failed: false }));
    const t = setTimeout(() => {
      fetchInsights(farm, codesKey.split("|"), cycle)
        .then((data) => alive && setIns({ data, loading: false, failed: false }))
        .catch(() => alive && setIns((s) => ({ ...s, loading: false, failed: true })));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [farm, cycle, codesKey]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([]);
        return;
      }
      const r = await searchChemicalItems(query.trim());
      if (!cancelled) setResults(r);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const editable = req ? isEditable(req.status) : false;

  async function save(then?: "submit") {
    if (!req) return;
    setBusy(true);
    try {
      const items = rows
        .filter((r) => Number(r.qty) > 0)
        .map((r) => ({
          item_code: r.item_code,
          requested_qty: Number(r.qty),
          uom: r.uom,
          note: r.note,
        }));
      await saveRequirement(req.name, items);
      if (then === "submit") {
        await submitRequirement(req.name);
        push("Sent for review", "ok");
      } else {
        push("Saved", "ok");
      }
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function sendAmendment() {
    if (!req) return;
    const items = Object.entries(amendRows)
      .filter(([, v]) => v !== "" && !Number.isNaN(Number(v)))
      .map(([item_code, v]) => ({ item_code, proposed_qty: Number(v) }));
    if (!items.length) {
      push("Set a new quantity on at least one line", "err");
      return;
    }
    setBusy(true);
    try {
      await requestAmendment(req.name, items, amendReason);
      push("Amendment requested", "ok");
      setAmendOpen(false);
      setAmendReason("");
      setAmendRows({});
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  if (!farm) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="No farm"
        detail="You are not assigned to a farm that raises chemical requirements."
      />
    );
  }
  if (!req && reqError) {
    return <LoadFailed message={reqError} onRetry={() => void load()} />;
  }
  if (!req) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex flex-col gap-1.5">
              <TextSkeleton width="22ch" />
              <TextSkeleton width="30ch" />
            </div>
            <Bar className="h-9 w-48" />
          </CardContent>
        </Card>
        <TableCardSkeleton heads={TAB_HEADS.requirement} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <p className="font-medium">
              {req.farm} · {req.name}
            </p>
            <p className="text-sm text-muted-foreground">
              {describeRequirement(req)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={req.status} />
            {editable ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void save()}>
                  Save draft
                </Button>
                <Button disabled={busy} onClick={() => void save("submit")}>
                  <Send className="mr-1 size-4" /> Submit
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                disabled={busy || req.status === "Amendment Requested"}
                onClick={() => setAmendOpen(true)}
              >
                <FileText className="mr-1 size-4" /> Request amendment
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!editable && (
        <p className="text-sm text-muted-foreground">
          This requirement has been reviewed, so the quantities are no longer edited
          directly. An amendment records what you want changed, and why, before it
          moves.
        </p>
      )}

      {editable && (
        <Card>
          <CardContent className="flex flex-col gap-2 py-4">
            <Input
              placeholder="Search a chemical or foliar by name or code…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <div className="max-h-56 overflow-auto rounded-md border">
                {results.map((it) => (
                  <button
                    key={it.item_code}
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setRows((r) =>
                        r.some((x) => x.item_code === it.item_code)
                          ? r
                          : [
                              ...r,
                              {
                                item_code: it.item_code,
                                item_name: it.item_name || it.item_code,
                                uom: it.stock_uom || it.uoms?.[0]?.uom || "",
                                qty: "",
                              },
                            ],
                      );
                      setQuery("");
                      setResults([]);
                    }}
                  >
                    <span>{it.item_name || it.item_code}</span>
                    <span className="text-xs text-muted-foreground">
                      {it.item_code}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chemical</TableHead>
                <TableHead className="w-40 text-right">Quantity</TableHead>
                <TableHead className="w-24">UOM</TableHead>
                {editable && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    Nothing requested yet.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r, i) => (
                <TableRow key={r.item_code}>
                  <TableCell>
                    <div className="font-medium">{r.item_name}</div>
                    <div className="text-xs text-muted-foreground">{r.item_code}</div>
                    {editable && (
                      <InsightLine
                        state={insightState(
                          ins.loading && !ins.data?.items?.[r.item_code],
                          ins.failed,
                          ins.data?.items,
                          r.item_code,
                        )}
                        qty={Number(r.qty) || 0}
                        weeks={ins.data?.weeks}
                        currency={ins.data?.currency || undefined}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {editable ? (
                      <Input
                        inputMode="decimal"
                        className="ml-auto w-32 text-right"
                        value={r.qty}
                        onChange={(e) =>
                          setRows((rs) =>
                            rs.map((x, j) =>
                              j === i ? { ...x, qty: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    ) : (
                      fmtQty(Number(r.qty))
                    )}
                  </TableCell>
                  <TableCell>{r.uom}</TableCell>
                  {editable && (
                    <TableCell>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() =>
                          setRows((rs) => rs.filter((_, j) => j !== i))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={amendOpen} onOpenChange={setAmendOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Request an amendment</DialogTitle>
            <DialogDescription>
              Name the new quantity for each line you want changed. The request is
              recorded with your name and reason, and someone decides on it — the
              figures do not move on their own.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {req.items.map((it) => (
              <div key={it.item_code} className="flex items-center gap-2">
                <div className="flex-1 text-sm">
                  <div>{it.item_name || it.item_code}</div>
                  <div className="text-xs text-muted-foreground">
                    now {fmtQty(it.requested_qty)} {it.uom}
                  </div>
                </div>
                <Input
                  inputMode="decimal"
                  className="w-28 text-right"
                  placeholder="new"
                  value={amendRows[it.item_code] ?? ""}
                  onChange={(e) =>
                    setAmendRows((a) => ({ ...a, [it.item_code]: e.target.value }))
                  }
                />
              </div>
            ))}
            <Input
              placeholder="Why is this changing?"
              value={amendReason}
              onChange={(e) => setAmendReason(e.target.value)}
            />
            <Button disabled={busy || !amendReason.trim()} onClick={() => void sendAmendment()}>
              Send request
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "Planner Approved" || status === "Granted"
      ? "default"
      : status === "Rejected" || status === "Declined"
        ? "destructive"
        : "secondary";
  return <Badge variant={tone as "default" | "destructive" | "secondary"}>{status}</Badge>;
}

// ── review 1 + amendments ─────────────────────────────────────────────────

function ReviewTab({
  cycle,
  push,
  busy,
  setBusy,
}: {
  cycle: string;
  push: (m: string, v?: ToastItem["kind"]) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const crop = useContext(CropCtx);
  const [reqs, setReqs] = useState<(Requirement & { total_lines: number })[]>([]);
  const [breakdown, setBreakdown] = useState<ItemBreakdown | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [amendments, setAmendments] = useState<Amendment[]>([]);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Another cycle: its rows pulse until they land, not the old cycle's.
  useEffect(() => {
    setLoaded(false);
    setLoadError(null);
    setBreakdown(null);
  }, [cycle]);

  const loadBreakdown = useCallback(async () => {
    try {
      setBreakdown(await itemBreakdown(cycle, crop));
      setBreakdownError(null);
    } catch (e) {
      setBreakdownError(errText(e));
    }
  }, [cycle, crop]);

  const load = useCallback(async () => {
    void loadBreakdown();
    try {
      const [r, a] = await Promise.all([
        requirementsFor(cycle, crop),
        listAmendments(cycle, "Pending", crop),
      ]);
      setReqs(r);
      setAmendments(a);
      setLoadError(null);
      setLoaded(true);
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [cycle, crop, loadBreakdown]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(name: string, decision: "approve" | "reject", why?: string) {
    setBusy(true);
    try {
      await reviewRequirement(name, decision, why);
      push(decision === "approve" ? "Approved" : "Rejected", "ok");
      setRejecting(null);
      setReason("");
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function decideAmd(name: string, decision: "grant" | "decline") {
    setBusy(true);
    try {
      await decideAmendment(name, decision);
      push(decision === "grant" ? "Amendment applied" : "Amendment declined", "ok");
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {amendments.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <p className="font-medium">Amendments awaiting a decision</p>
            {amendments.map((a) => (
              <div key={a.name} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {a.farm} · {a.requirement}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.requested_by} — {a.reason}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void decideAmd(a.name, "grant")}
                    >
                      Grant
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void decideAmd(a.name, "decline")}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  {a.items.map((i) => (
                    <span key={i.item_code} className="rounded bg-muted px-2 py-1">
                      {i.item_name || i.item_code}: {fmtQty(i.current_qty)} →{" "}
                      <strong>{fmtQty(i.proposed_qty)}</strong>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <FarmBreakdown data={breakdown} error={breakdownError} onRetry={() => void loadBreakdown()} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Farm</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="w-64" />
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={(!loaded && !loadError) || undefined}>
              {!loaded && !loadError && <TableRowsSkeleton cols={4} rows={5} />}
              {!loaded && loadError && (
                <TableRow>
                  <TableCell colSpan={4} role="alert" className="py-6 text-center text-destructive">
                    {loadError}{" "}
                    <Button variant="link" size="sm" onClick={() => void load()}>
                      Try again
                    </Button>
                  </TableCell>
                </TableRow>
              )}
              {loaded && reqs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    No requirements on this cycle yet.
                  </TableCell>
                </TableRow>
              )}
              {reqs.map((r) => (
                <TableRow key={r.name}>
                  <TableCell>
                    <div className="font-medium">{r.farm}</div>
                    <div className="text-xs text-muted-foreground">{r.name}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                    {r.rejection_reason && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {r.rejection_reason}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">{r.total_lines}</TableCell>
                  <TableCell>
                    {(r.status === "Submitted" ||
                      r.status === "Amendment Requested") && (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void decide(r.name, "approve")}
                        >
                          <CheckCircle2 className="mr-1 size-4" /> Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setRejecting(r.name)}
                        >
                          <XCircle className="mr-1 size-4" /> Reject
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!rejecting} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this requirement</DialogTitle>
            <DialogDescription>
              The planner cannot simply edit it afterwards — they raise an amendment.
              So the reason is what they will work from.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Why?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            disabled={busy || !reason.trim()}
            onClick={() => rejecting && void decide(rejecting, "reject", reason)}
          >
            Reject
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── consolidation + reduction ─────────────────────────────────────────────

function ConsolidatedTab({
  cycle,
  push,
  busy,
  setBusy,
}: {
  cycle: string;
  push: (m: string, v?: ToastItem["kind"]) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const crop = useContext(CropCtx);
  const [detail, setDetail] = useState<CycleDetail | null>(null);
  const [breakdown, setBreakdown] = useState<ItemBreakdown | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { mode: ReductionMode; value: string }>>({});
  useEffect(() => {
    setDetail(null);
    setLoadError(null);
  }, [cycle]);

  const load = useCallback(async () => {
    try {
      setDetail(await getCycle(cycle, crop));
      setLoadError(null);
      // The farm columns behind each total, for reading before a line is approved.
      itemBreakdown(cycle, crop).then(setBreakdown).catch(() => setBreakdown(null));
    } catch (e) {
      push(errText(e), "err");
      setLoadError(errText(e));
    }
  }, [cycle, push, crop]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<CycleDetail | string>, ok: string) {
    setBusy(true);
    try {
      const out = await fn();
      push(typeof out === "string" ? `${ok}: ${out}` : ok, "ok");
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  if (!detail && loadError) {
    return <LoadFailed message={loadError} onRetry={() => void load()} />;
  }
  if (!detail) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled>
            <Scale className="mr-1 size-4" /> Consolidate requirements
          </Button>
          <Button disabled>
            <FileText className="mr-1 size-4" /> Raise Material Request
          </Button>
        </div>
        <TableCardSkeleton heads={TAB_HEADS.consolidated} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void run(() => consolidateCycle(cycle), "Consolidated")}
        >
          <Scale className="mr-1 size-4" /> Consolidate requirements
        </Button>
        <Button
          disabled={busy || !!detail.material_request}
          onClick={() => void run(() => createMaterialRequest(cycle), "Material Request raised")}
        >
          <FileText className="mr-1 size-4" /> Raise Material Request
        </Button>
        {detail.material_request && (
          <Badge variant="secondary" className="self-center">
            {detail.material_request} (draft — purchasing submits it)
          </Badge>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chemical</TableHead>
                <TableHead className="text-right">Requested</TableHead>
                <TableHead className="w-36">Reduce by</TableHead>
                <TableHead className="w-32 text-right">Value</TableHead>
                <TableHead className="text-right">Approved</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nothing consolidated yet — approve some requirements first.
                  </TableCell>
                </TableRow>
              )}
              {detail.lines.map((l) => {
                const draft = drafts[l.item_code] ?? {
                  mode: l.reduction_mode,
                  value: String(l.reduction_value || ""),
                };
                const preview = resolveReduction(
                  l.total_requested,
                  draft.mode,
                  Number(draft.value) || 0,
                );
                const dirty =
                  draft.mode !== l.reduction_mode ||
                  Number(draft.value || 0) !== l.reduction_value;
                const expanded = open.has(l.item_code);
                return (
                  <Fragment key={l.item_code}>
                  <TableRow className={cn(l.final_approved && "bg-muted/40")}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        <button
                          type="button"
                          aria-label={`Farms for ${l.item_name || l.item_code}`}
                          aria-expanded={expanded}
                          disabled={!breakdown}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                          onClick={() =>
                            setOpen((o) => {
                              const n = new Set(o);
                              if (n.has(l.item_code)) n.delete(l.item_code);
                              else n.add(l.item_code);
                              return n;
                            })
                          }
                        >
                          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                        {l.final_approved && <Lock className="size-3.5 text-muted-foreground" />}
                        {l.item_name || l.item_code}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {l.item_code} · step {fmtQty(l.allocation_step)} {l.uom}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtQty(l.total_requested)} {l.uom}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={draft.mode}
                        disabled={l.final_approved}
                        onValueChange={(v) =>
                          setDrafts((d) => ({
                            ...d,
                            [l.item_code]: { ...draft, mode: v as ReductionMode },
                          }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="None">No cut</SelectItem>
                          <SelectItem value="Absolute">New total</SelectItem>
                          <SelectItem value="Percentage">Percent off</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        inputMode="decimal"
                        className="ml-auto w-24 text-right"
                        disabled={l.final_approved || draft.mode === "None"}
                        value={draft.value}
                        onChange={(e) =>
                          setDrafts((d) => ({
                            ...d,
                            [l.item_code]: { ...draft, value: e.target.value },
                          }))
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {fmtQty(dirty ? preview : l.approved_qty)} {l.uom}
                      {dirty && (
                        <div className="text-xs text-muted-foreground">unsaved</div>
                      )}
                    </TableCell>
                    <TableCell>
                      {l.final_approved ? (
                        <Badge variant="secondary">final</Badge>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || !dirty}
                            onClick={() =>
                              void run(
                                () =>
                                  setReduction(
                                    cycle,
                                    l.item_code,
                                    draft.mode,
                                    Number(draft.value) || 0,
                                  ),
                                "Saved — planners notified",
                              )
                            }
                          >
                            Apply
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void run(() => finaliseLine(cycle, l.item_code), "Locked as final")
                            }
                          >
                            <Lock className="size-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                  {expanded && breakdown && (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-muted/20 p-3">
                        <FarmBreakdown data={breakdown} onlyItem={l.item_code} />
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
      <p className="text-sm text-muted-foreground">
        Applying a cut notifies every affected farm's planners with the old and new
        figure. Locking a line marks it final — after that it takes an amendment,
        not an edit.
      </p>
      <MoneyCard cycle={cycle} version={detail} />
    </div>
  );
}

/** B5: the cycle in money next to its quantities — per farm, the value of what
 *  was asked, approved and allocated, what the farm has committed this fiscal
 *  year, and its ERPNext Budget. Over budget warns; it never blocks. */
function MoneyCard({ cycle, version }: { cycle: string; version: unknown }) {
  const [money, setMoney] = useState<CycleMoney | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFailed(null);
    cycleMoney(cycle)
      .then((m) => alive && setMoney(m))
      .catch((e) => alive && setFailed(errText(e)));
    return () => {
      alive = false;
    };
  }, [cycle, version]);

  const fmt = useMemo(() => {
    const cur = money?.currency || "KES";
    const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    return (n: number | null | undefined) =>
      n === null || n === undefined ? "—" : `${cur} ${nf.format(Math.round(n))}`;
  }, [money?.currency]);

  const over = (money?.farms || []).filter((f) => f.over_budget);
  const heads = ["Farm", "Requirement", "Approved", "Allocated", "Committed this year", "Budget"];

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div>
          <p className="font-medium">Money by farm</p>
          <p className="text-sm text-muted-foreground">
            Quantities valued at each chemical's last purchase rate (else its valuation
            rate). Committed this year adds the farm's other approved cycles in fiscal
            year {money?.fiscal_year || "—"}; budget is the submitted ERPNext Budget on
            the farm's cost centre. Approving drafts the year's Budgets for you to submit
            in ERPNext.
          </p>
        </div>
        {over.length > 0 && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              Over budget:{" "}
              {over
                .map((f) => `${f.farm} commits ${fmt(f.fy_committed)} against ${fmt(f.budget)}`)
                .join("; ")}
              . Approving still goes ahead — this is a warning, not a stop.
            </p>
          </div>
        )}
        {failed ? (
          <p className="text-sm text-destructive">{failed}</p>
        ) : (
          <Table aria-label="Money by farm">
            <TableHeader>
              <TableRow>
                {heads.map((h, i) => (
                  <TableHead key={h} className={i ? "text-right" : undefined}>
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={!money || undefined}>
              {!money && <TableRowsSkeleton cols={heads.length} rows={3} />}
              {money && money.farms.length === 0 && (
                <TableRow>
                  <TableCell colSpan={heads.length} className="py-6 text-center text-muted-foreground">
                    Nothing approved to value yet.
                  </TableCell>
                </TableRow>
              )}
              {money?.farms.map((f) => (
                <TableRow key={f.farm}>
                  <TableCell>
                    <div className="font-medium">{f.farm}</div>
                    <div className="text-xs text-muted-foreground">
                      {f.cost_center || (
                        <Badge variant="secondary">No cost centre</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(f.requirement_value)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(f.approved_value)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmt(f.allocated_value)}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      f.over_budget && "font-medium text-amber-700 dark:text-amber-500",
                    )}
                  >
                    {fmt(f.fy_committed)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {f.budget !== null ? (
                      fmt(f.budget)
                    ) : f.draft_budget !== null ? (
                      <span className="text-muted-foreground">{fmt(f.draft_budget)} draft</span>
                    ) : (
                      <span className="text-muted-foreground">none</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!!money?.warnings.length && (
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {money.warnings.map((w) => (
              <li key={w} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
                {w}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── allocation ────────────────────────────────────────────────────────────

function AllocationTab({
  cycle,
  push,
  busy,
  setBusy,
}: {
  cycle: string;
  push: (m: string, v?: ToastItem["kind"]) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const crop = useContext(CropCtx);
  const [lines, setLines] = useState<AllocationPreviewLine[]>([]);
  const [mode, setMode] = useState<AllocationMode>("simple");
  const [received, setReceived] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<CycleDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setLoadError(null);
  }, [cycle]);

  const receivedMap = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(received)) {
      if (v !== "" && !Number.isNaN(Number(v))) out[k] = Number(v);
    }
    return Object.keys(out).length ? out : undefined;
  }, [received]);

  const load = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        previewAllocation(cycle, receivedMap, crop),
        getCycle(cycle, crop),
      ]);
      setLines(p.lines);
      setMode(p.mode || "simple");
      setDetail(d);
      setLoadError(null);
    } catch (e) {
      push(errText(e), "err");
      setLoadError(errText(e));
    }
  }, [cycle, receivedMap, push, crop]);

  useEffect(() => {
    void load();
  }, [load]);

  const balanced = mode === "balanced";

  return (
    <div className="flex flex-col gap-4">
      {/* Which rule is running, in plain words. A split nobody can account for is
        * worse than a cruder one, and the two modes differ by whole steps. */}
      <Card>
        <CardContent className="py-3 text-sm text-muted-foreground">
          {!detail ? (
            <span className="flex flex-col gap-1.5" aria-hidden>
              <TextSkeleton width="90%" />
              <TextSkeleton width="60%" />
            </span>
          ) : balanced ? (
            <>
              <strong className="text-foreground">Balanced split.</strong> Leftover
              measurable amounts go to the farms with the largest fractions, and each
              farm's shortfall is carried forward as a credit against its next
              request.
            </>
          ) : (
            <>
              <strong className="text-foreground">Simple split.</strong> Each farm's
              share is rounded down to an amount the store can measure; whatever will
              not divide evenly stays in the general store, and nothing is carried
              forward. The General Manager can switch to a balanced split in
              Settings.
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await publishAllocation(cycle, receivedMap);
              push("Allocation published — farms notified", "ok");
              await load();
            } catch (e) {
              push(errText(e), "err");
            } finally {
              setBusy(false);
            }
          }}
        >
          <CheckCircle2 className="mr-1 size-4" /> Publish allocation
        </Button>
        <Button
          variant="outline"
          disabled={busy || !detail?.allocations.length}
          onClick={async () => {
            setBusy(true);
            try {
              const out = await transferAllocation(cycle);
              push(
                `${out.entries.length} transfer(s) posted` +
                  (out.skipped.length ? `, ${out.skipped.length} skipped` : ""),
                out.skipped.length ? "err" : "ok",
              );
              await load();
            } catch (e) {
              push(errText(e), "err");
            } finally {
              setBusy(false);
            }
          }}
        >
          <ArrowRightLeft className="mr-1 size-4" /> Transfer to farm stores
        </Button>
      </div>

      {lines.map((l) => (
        <Card key={l.item_code}>
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{l.item_name || l.item_code}</p>
                <p className="text-xs text-muted-foreground">
                  step {fmtQty(l.step)} {l.uom} · {fmtQty(l.distributed)} allocated ·{" "}
                  {fmtQty(l.remainder)} left in the general store
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Received</span>
                <Input
                  inputMode="decimal"
                  className="w-28 text-right"
                  placeholder={String(l.received)}
                  value={received[l.item_code] ?? ""}
                  onChange={(e) =>
                    setReceived((r) => ({ ...r, [l.item_code]: e.target.value }))
                  }
                />
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Farm</TableHead>
                  <TableHead className="text-right">Requested</TableHead>
                  {balanced && <TableHead className="text-right">Carried in</TableHead>}
                  <TableHead className="text-right">Allocated</TableHead>
                  {balanced && (
                    <TableHead className="text-right">Carries forward</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {l.allocations.map((a) => (
                  <TableRow key={a.farm}>
                    <TableCell>{a.farm}</TableCell>
                    <TableCell className="text-right">{fmtQty(a.requested)}</TableCell>
                    {balanced && (
                      <TableCell className="text-right text-muted-foreground">
                        {Math.abs(a.credit_in) < 1e-9
                          ? "—"
                          : describeCredit(a.credit_in, l.uom)}
                      </TableCell>
                    )}
                    <TableCell className="text-right font-medium">
                      {fmtQty(a.allocated)} {l.uom}
                    </TableCell>
                    {balanced && (
                      <TableCell className="text-right text-muted-foreground">
                        {describeCredit(a.credit_out, l.uom)}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      {!detail && loadError && <LoadFailed message={loadError} onRetry={() => void load()} />}
      {!detail && !loadError && <TableCardSkeleton heads={TAB_HEADS.allocation} rows={4} />}

      {detail?.allocations.length ? <BudgetTable cycle={cycle} /> : null}

      {detail && lines.length === 0 && (
        <EmptyState
          icon={Scale}
          title="Nothing to split"
          detail="Consolidate and approve the cycle's chemicals first; the split follows what was approved, or what you enter as actually received."
        />
      )}
    </div>
  );
}

// ── the general store ─────────────────────────────────────────────────────

function PoolTab({
  farm,
  isKeeper,
  push,
  busy,
  setBusy,
}: {
  farm: string;
  isKeeper: boolean;
  push: (m: string, v?: ToastItem["kind"]) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const crop = useContext(CropCtx);
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [incoming, setIncoming] = useState<PoolRequest[]>([]);
  const [outgoing, setOutgoing] = useState<PoolRequest[]>([]);
  const [askOpen, setAskOpen] = useState(false);
  const [askRows, setAskRows] = useState<BasketRow[]>([]);
  const [askReason, setAskReason] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ChemicalItem[]>([]);

  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [s, inc, out] = await Promise.all([
        poolStatus(undefined, crop),
        isKeeper ? listPoolRequests("incoming", crop) : Promise.resolve([]),
        listPoolRequests("outgoing", crop),
      ]);
      setStatus(s);
      setIncoming(inc.filter((r) => r.workflow_state === "Pending Approval"));
      setOutgoing(out);
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [isKeeper, crop]);
  // Still waiting for the first answer (a failure ends the skeletons).
  const pending = !status && !loadError;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([]);
        return;
      }
      const r = await searchChemicalItems(query.trim());
      if (!cancelled) setResults(r);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  async function ask() {
    setBusy(true);
    try {
      const items = askRows
        .filter((r) => Number(r.qty) > 0)
        .map((r) => ({ item_code: r.item_code, requested_qty: Number(r.qty), uom: r.uom }));
      const out = await requestFromPool(farm, items, askReason);
      push(
        out.over_available.length
          ? `Sent — ${out.over_available.length} line(s) exceed what is free right now`
          : "Sent to the general store keeper",
        out.over_available.length ? "err" : "ok",
      );
      setAskOpen(false);
      setAskRows([]);
      setAskReason("");
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  async function decide(req: PoolRequest, approve: boolean) {
    setBusy(true);
    try {
      await decidePoolRequest(
        req.name,
        req.items.map((i) => ({
          item_code: i.item_code,
          status: approve ? ("Approved" as const) : ("Rejected" as const),
          approved_qty: i.requested_qty,
        })),
      );
      push(approve ? "Approved and transferred" : "Declined", "ok");
      await load();
    } catch (e) {
      push(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  const credits = status?.credits || [];

  return (
    <div className="flex flex-col gap-4">
      {!status && loadError && <LoadFailed message={loadError} onRetry={() => void load()} />}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="gap-1">
          <Warehouse className="size-3.5" />
          {status ? status.store || "no general store" : pending ? <TextSkeleton width="12ch" /> : "—"}
        </Badge>
        {farm && (
          <Button variant="outline" disabled={busy} onClick={() => setAskOpen(true)}>
            <Plus className="mr-1 size-4" /> Ask for stock from the pool
          </Button>
        )}
      </div>

      {isKeeper && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4">
            <p className="font-medium">Requests waiting on you</p>
            {pending && <RowsSkeleton rows={2} />}
            {status && incoming.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing waiting.</p>
            )}
            {incoming.map((r) => (
              <div key={r.name} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{r.requesting_farm}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.name}
                      {r.reason ? ` — ${r.reason}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void decide(r, true)}>
                      Approve all
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void decide(r, false)}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-sm">
                  {r.items.map((i) => {
                    const tight =
                      typeof i.lender_on_hand === "number" &&
                      i.requested_qty > i.lender_on_hand;
                    return (
                      <span
                        key={i.item_code}
                        className={cn(
                          "flex items-center gap-1 rounded px-2 py-1",
                          tight ? "bg-destructive/10 text-destructive" : "bg-muted",
                        )}
                      >
                        {tight && <AlertTriangle className="size-3.5" />}
                        {i.item_name || i.item_code}: {fmtQty(i.requested_qty)} {i.uom}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="flex flex-col gap-2 py-4">
          <p className="font-medium">What the pool owes</p>
          <p className="text-sm text-muted-foreground">
            Stock stays here when a farm's exact share is smaller than the store can
            measure.{" "}
            {!status ? (
              pending ? <TextSkeleton width="28ch" /> : null
            ) : status.mode === "balanced" ? (
              <>These credits are added to that farm's next request.</>
            ) : (
              <>
                Credits are <strong>on hold</strong> — the simple split is in use, so
                nothing is carried forward. They resume if the General Manager
                switches balancing back on.
              </>
            )}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chemical</TableHead>
                <TableHead>Farm</TableHead>
                <TableHead className="text-right">Carried</TableHead>
                <TableHead>Since</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={pending || undefined}>
              {pending && <TableRowsSkeleton cols={4} rows={3} />}
              {status && credits.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Nothing outstanding.
                  </TableCell>
                </TableRow>
              )}
              {credits.map((c) => (
                <TableRow key={`${c.item_code}::${c.farm}`}>
                  <TableCell>{c.item_name || c.item_code}</TableCell>
                  <TableCell>{c.farm}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right",
                      c.credit_qty < 0 && "text-muted-foreground",
                    )}
                  >
                    {describeCredit(c.credit_qty, c.uom)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.last_cycle || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {outgoing.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2 py-4">
            <p className="font-medium">My farms' requests</p>
            {outgoing.map((r) => (
              <div
                key={r.name}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
              >
                <span>
                  {r.requesting_farm} · {r.items.length} item(s)
                </span>
                <Badge variant="secondary">{r.workflow_state}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={askOpen} onOpenChange={setAskOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Ask the general store</DialogTitle>
            <DialogDescription>
              The keeper decides each line. Anything your farm is already owed from a
              previous split is shown to them alongside the request.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              placeholder="Search a chemical…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <div className="max-h-40 overflow-auto rounded-md border">
                {results.map((it) => (
                  <button
                    key={it.item_code}
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      setAskRows((r) =>
                        r.some((x) => x.item_code === it.item_code)
                          ? r
                          : [
                              ...r,
                              {
                                item_code: it.item_code,
                                item_name: it.item_name || it.item_code,
                                uom: it.stock_uom || it.uoms?.[0]?.uom || "",
                                qty: "",
                              },
                            ],
                      );
                      setQuery("");
                      setResults([]);
                    }}
                  >
                    <span>{it.item_name || it.item_code}</span>
                    <span className="text-xs text-muted-foreground">{it.item_code}</span>
                  </button>
                ))}
              </div>
            )}
            {askRows.map((r, i) => (
              <div key={r.item_code} className="flex items-center gap-2">
                <span className="flex-1 text-sm">{r.item_name}</span>
                <Input
                  inputMode="decimal"
                  className="w-28 text-right"
                  value={r.qty}
                  onChange={(e) =>
                    setAskRows((rs) =>
                      rs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setAskRows((rs) => rs.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Input
              placeholder="Why do you need it?"
              value={askReason}
              onChange={(e) => setAskReason(e.target.value)}
            />
            <Button disabled={busy || askRows.length === 0} onClick={() => void ask()}>
              Send request
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewCycleDialog({
  open,
  onOpenChange,
  push,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  push: (m: string, v?: ToastItem["kind"]) => void;
  onCreated: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [companies, setCompanies] = useState<
    { company: string; general_store: string }[]
  >([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const crop = useContext(CropCtx);

  // Only companies with a general store: a cycle without a pool has nowhere to
  // receive the purchase, and finding that out at the Material Request is late.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const cs = await companiesForCycle(crop);
      if (cancelled) return;
      setCompanies(cs);
      setCompany((prev) => prev || cs[0]?.company || "");
    })();
    return () => {
      cancelled = true;
    };
  }, [open, crop]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a procurement cycle</DialogTitle>
          <DialogDescription>
            Farms state what they need against a cycle, so one has to exist before
            anybody can ask for anything. It also fixes the period the
            consumption-against-allocation figures are measured over.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Name, e.g. September spray round"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select value={company} onValueChange={setCompany}>
            <SelectTrigger>
              <SelectValue placeholder="Company" />
            </SelectTrigger>
            <SelectContent>
              {companies.map((c) => (
                <SelectItem key={c.company} value={c.company}>
                  {c.company} — {c.general_store}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {companies.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No company has a general store yet, so there is nowhere for a
              purchase to land. Create one before opening a cycle.
            </p>
          )}
          <div className="flex gap-2">
            <DateRangePicker
              variant="field"
              label="Cycle dates"
              value={{ from: start, to: end }}
              onChange={(r) => {
                setStart(r.from);
                setEnd(r.to);
              }}
            />
          </div>
          <Button
            disabled={busy || !name.trim() || !company || !start || !end}
            onClick={async () => {
              setBusy(true);
              try {
                const created = await createCycle({
                  cycle_name: name.trim(),
                  company,
                  period_start: start,
                  period_end: end,
                });
                push(`Cycle ${created} open`, "ok");
                onOpenChange(false);
                setName("");
                await onCreated(created);
              } catch (e) {
                push(errText(e), "err");
              } finally {
                setBusy(false);
              }
            }}
          >
            Open cycle
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Consumption against allocation — the "who is over budget" question.
 *
 *  Loans are part of consumption by construction: the figure is what actually
 *  left the farm's store over the cycle's period, so a borrowed chemical shows up
 *  when it is used. That is the point — a farm that borrows has consumed more than
 *  it was allocated, and the reconciliation should say so rather than hide it. */
function BudgetTable({ cycle }: { cycle: string }) {
  const crop = useContext(CropCtx);
  const [rows, setRows] = useState<
    { farm: string; item_code: string; allocated: number; consumed: number; over: number }[]
  >([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      try {
        const out = await consumptionVsAllocation(cycle, crop);
        if (!cancelled) setRows(out);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cycle, crop]);

  const over = rows.filter((r) => r.over > 0);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 py-4">
        <p className="font-medium">Consumption against allocation</p>
        <p className="text-sm text-muted-foreground">
          What each farm actually issued from its store over the cycle's period,
          against what it was allocated. A farm that borrowed will read as over —
          that is the borrowing showing up, not an error.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Farm</TableHead>
              <TableHead>Chemical</TableHead>
              <TableHead className="text-right">Allocated</TableHead>
              <TableHead className="text-right">Consumed</TableHead>
              <TableHead className="text-right">Over</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={!loaded || undefined}>
            {!loaded && <TableRowsSkeleton cols={5} rows={3} />}
            {loaded && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  Nothing to reconcile yet.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={`${r.farm}::${r.item_code}`}>
                <TableCell>{r.farm}</TableCell>
                <TableCell>{r.item_code}</TableCell>
                <TableCell className="text-right">{fmtQty(r.allocated)}</TableCell>
                <TableCell className="text-right">{fmtQty(r.consumed)}</TableCell>
                <TableCell
                  className={cn(
                    "text-right",
                    r.over > 0 ? "font-medium text-destructive" : "text-muted-foreground",
                  )}
                >
                  {r.over > 0 ? fmtQty(r.over) : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {over.length > 0 && (
          <p className="flex items-center gap-1 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {over.length} farm/chemical pair(s) over allocation.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
