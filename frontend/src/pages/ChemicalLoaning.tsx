/**
 * Chemical & foliar loaning — directed, multi-item.
 *
 * A farm's planner addresses ONE lending farm and asks for several chemicals or
 * foliars at once. The lender decides each line on its own from the Incoming tab:
 * approve in full, approve less, or decline.
 *
 * Two things shape this UI:
 *
 * * **The lender's stock is never browsable.** You add the items you want first
 *   and only then see their on-hand — the server has no browse endpoint, by
 *   design, so a borrower cannot enumerate another farm's inventory.
 * * **Chemicals and foliars are both loanable** and live in different stores, so
 *   each row shows which store its stock will actually come from.
 *
 * Replaces the earlier flow where one chemical was split across up to five
 * lenders, which meant every farm could see the request.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Inbox,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/PageHeader";
import { HeaderIconButton } from "@/components/header-controls";
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
import { Toaster, type ToastItem } from "@/components/Toaster";
import { cn } from "@/lib/utils";
import { FrappeError } from "@/lib/frappe";
import { fmtQty } from "@/lib/uom";
import { searchChemicalItems, type ChemicalItem } from "@/lib/scouting-api";
import {
  createDirectedLoan,
  decideLoanItems,
  fetchLenderStock,
  fetchMyFarms,
  isOverHalf,
  listDirectedLoans,
  listLenderFarms,
  rejectLoanRequest,
  summariseLoan,
  type LenderStockRow,
  type LoanRequestV2,
} from "@/lib/loaning-api";

interface BasketRow {
  rowId: string;
  item_code: string;
  item_name: string;
  qty: string;
}

let rowSeq = 0;
const newRowId = () => `r${++rowSeq}`;

export function ChemicalLoaning() {
  const [tab, setTab] = useState<"request" | "incoming" | "outgoing">("request");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const dismissToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  const pushToast = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  // -- scope ---------------------------------------------------------------
  const [farms, setFarms] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [myFarm, setMyFarm] = useState("");
  const [lenders, setLenders] = useState<string[]>([]);
  const [lender, setLender] = useState("");

  useEffect(() => {
    fetchMyFarms()
      .then((r) => {
        setFarms(r?.farms ?? []);
        setEnabled(r?.enabled !== false);
        if (r?.farms?.length) setMyFarm((f) => f || r.farms[0]);
      })
      .catch(() => setFarms([]));
  }, []);

  useEffect(() => {
    if (!myFarm) return;
    listLenderFarms(myFarm).then((l) => {
      setLenders(l);
      setLender((cur) => (l.includes(cur) ? cur : ""));
    });
  }, [myFarm]);

  // -- basket --------------------------------------------------------------
  const [basket, setBasket] = useState<BasketRow[]>([]);
  const [reason, setReason] = useState("");
  const [stock, setStock] = useState<Record<string, LenderStockRow>>({});
  const [stockLoading, setStockLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState<ChemicalItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // On-hand is fetched only for what's in the basket — the server has no
  // browse endpoint, so items are named first and disclosed second.
  useEffect(() => {
    const codes = basket.map((b) => b.item_code).filter(Boolean);
    if (!lender || !codes.length) {
      setStock({});
      return;
    }
    let cancelled = false;
    setStockLoading(true);
    fetchLenderStock(lender, codes)
      .then((s) => {
        if (!cancelled) setStock(s);
      })
      .finally(() => {
        if (!cancelled) setStockLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lender, basket]);

  useEffect(() => {
    if (!addOpen) return;
    const t = setTimeout(() => {
      searchChemicalItems(addQuery).then(setAddResults);
    }, 200);
    return () => clearTimeout(t);
  }, [addQuery, addOpen]);

  const addItem = (item: ChemicalItem) => {
    if (basket.some((b) => b.item_code === item.item_code)) {
      pushToast("err", `${item.item_name || item.item_code} is already in the request.`);
      return;
    }
    setBasket((b) => [
      ...b,
      {
        rowId: newRowId(),
        item_code: item.item_code,
        item_name: item.item_name || item.item_code,
        qty: "",
      },
    ]);
    setAddOpen(false);
    setAddQuery("");
  };

  const overHalfRows = useMemo(
    () =>
      basket.filter((b) => {
        const s = stock[b.item_code];
        const q = Number(b.qty);
        return s && s.on_hand > 0 && q > s.on_hand * 0.5;
      }),
    [basket, stock],
  );

  const shortRows = useMemo(
    () =>
      basket.filter((b) => {
        const s = stock[b.item_code];
        return s && Number(b.qty) > s.on_hand;
      }),
    [basket, stock],
  );

  const canSubmit =
    !!myFarm &&
    !!lender &&
    basket.length > 0 &&
    basket.every((b) => Number(b.qty) > 0) &&
    !shortRows.length &&
    !submitting;

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await createDirectedLoan({
        requesting_farm: myFarm,
        lender_farm: lender,
        items: basket.map((b) => ({
          item_code: b.item_code,
          requested_qty: Number(b.qty),
        })),
        reason: reason.trim() || undefined,
      });
      pushToast(
        "ok",
        `Request ${r.name} sent to ${lender}.` +
          (r.over_half.length
            ? ` They've been told it's over half their stock of ${r.over_half.join(", ")}.`
            : ""),
      );
      setBasket([]);
      setReason("");
      setTab("outgoing");
      void reload();
    } catch (e) {
      pushToast(
        "err",
        e instanceof FrappeError ? e.message : "Could not send the request.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  // -- inbox / outbox ------------------------------------------------------
  const [incoming, setIncoming] = useState<LoanRequestV2[] | null>(null);
  const [outgoing, setOutgoing] = useState<LoanRequestV2[] | null>(null);

  const reload = useCallback(async () => {
    const [inc, out] = await Promise.all([
      listDirectedLoans("incoming"),
      listDirectedLoans("outgoing"),
    ]);
    setIncoming(inc);
    setOutgoing(out);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const pendingIncoming = useMemo(
    () =>
      (incoming ?? []).filter((r) =>
        (r.items || []).some((i) => i.status === "Pending"),
      ),
    [incoming],
  );

  if (!enabled) {
    return (
      <div className="flex flex-col">
        <PageHeader title="Loaning" />
        <div className="px-4 md:px-6 pb-6">
          <Card className="p-10 text-center text-sm text-muted-foreground">
            Loaning is switched off. Ask the SCP General Manager to enable it in
            Settings → Spray Plan.
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title="Loaning"
        eyebrow="Chemicals & foliars between farms"
        switcher={
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="request">
                <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
                Borrow
              </TabsTrigger>
              <TabsTrigger value="incoming">
                <Inbox className="mr-1.5 h-3.5 w-3.5" />
                Incoming
                {pendingIncoming.length ? (
                  <span className="ml-1.5 rounded-full bg-[var(--sd-data-red)] px-1.5 text-[0.6rem] font-semibold text-white">
                    {pendingIncoming.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="outgoing">Sent</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        {farms.length > 1 ? (
          <Select value={myFarm} onValueChange={setMyFarm}>
            <SelectTrigger className="h-9 w-44 text-xs">
              <SelectValue placeholder="My farm" />
            </SelectTrigger>
            <SelectContent>
              {farms.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <HeaderIconButton onClick={() => void reload()} title="Reload">
          <RefreshCw className="h-4 w-4" />
        </HeaderIconButton>
      </PageHeader>

      <div className="px-4 md:px-6 pb-6">
        {tab === "request" ? (
          <BorrowForm
            myFarm={myFarm}
            lenders={lenders}
            lender={lender}
            setLender={setLender}
            basket={basket}
            setBasket={setBasket}
            stock={stock}
            stockLoading={stockLoading}
            overHalfRows={overHalfRows}
            shortRows={shortRows}
            reason={reason}
            setReason={setReason}
            canSubmit={canSubmit}
            submitting={submitting}
            onAdd={() => setAddOpen(true)}
            onSubmit={submit}
          />
        ) : tab === "incoming" ? (
          <RequestList
            rows={incoming}
            role="lender"
            emptyText="No one has asked to borrow from your farms."
            onDecided={reload}
            pushToast={pushToast}
          />
        ) : (
          <RequestList
            rows={outgoing}
            role="borrower"
            emptyText="You haven't asked to borrow anything yet."
            onDecided={reload}
            pushToast={pushToast}
          />
        )}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add to the request</DialogTitle>
            <DialogDescription>
              Search by name or code. Chemicals and foliars are both loanable —
              you'll see {lender || "the lender"}'s stock once it's added.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={addQuery}
            onChange={(e) => setAddQuery(e.target.value)}
            placeholder="Search…"
            autoFocus
          />
          <div className="flex max-h-72 flex-col gap-1 overflow-auto">
            {addResults.map((it) => (
              <button
                key={it.item_code}
                type="button"
                onClick={() => addItem(it)}
                className="rounded-md border bg-card px-3 py-2 text-left hover:bg-muted"
              >
                <div className="text-xs font-medium">
                  {it.item_name || it.item_code}
                </div>
                <div className="font-mono text-[0.65rem] text-muted-foreground">
                  {it.item_code}
                  {it.is_fertilizer ? " · foliar" : " · chemical"}
                </div>
              </button>
            ))}
            {!addResults.length ? (
              <div className="py-3 text-center text-xs text-muted-foreground">
                Type to search.
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>

      <Toaster items={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function BorrowForm(props: {
  myFarm: string;
  lenders: string[];
  lender: string;
  setLender: (v: string) => void;
  basket: BasketRow[];
  setBasket: React.Dispatch<React.SetStateAction<BasketRow[]>>;
  stock: Record<string, LenderStockRow>;
  stockLoading: boolean;
  overHalfRows: BasketRow[];
  shortRows: BasketRow[];
  reason: string;
  setReason: (v: string) => void;
  canSubmit: boolean;
  submitting: boolean;
  onAdd: () => void;
  onSubmit: () => void;
}) {
  const {
    lenders, lender, setLender, basket, setBasket, stock, stockLoading,
    overHalfRows, shortRows, reason, setReason, canSubmit, submitting, onAdd, onSubmit,
  } = props;

  return (
    <Card className="p-4">
      <CardContent className="flex flex-col gap-4 p-0">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-56 flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Borrow from
            </label>
            <Select value={lender} onValueChange={setLender}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Pick a farm" />
              </SelectTrigger>
              <SelectContent>
                {lenders.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-1"
            disabled={!lender}
            onClick={onAdd}
          >
            <Plus className="h-3.5 w-3.5" />
            Add chemical or foliar
          </Button>
          {stockLoading ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              checking their stock…
            </span>
          ) : null}
        </div>

        {!lender ? (
          <p className="text-xs text-muted-foreground">
            Pick the farm you want to borrow from. Only they will see this
            request, and only they can approve it.
          </p>
        ) : !basket.length ? (
          <p className="text-xs text-muted-foreground">
            Add what you need. You'll see {lender}'s stock for each item once
            it's on the list.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead className="text-right">They have</TableHead>
                <TableHead>From store</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {basket.map((b) => {
                const s = stock[b.item_code];
                const short = Number(b.qty) > (s?.on_hand ?? Infinity);
                const half = overHalfRows.some((r) => r.rowId === b.rowId);
                return (
                  <TableRow key={b.rowId}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{b.item_name}</div>
                      <div className="font-mono text-[0.65rem] text-muted-foreground">
                        {b.item_code}
                        {s ? ` · ${s.kind}` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        value={b.qty}
                        inputMode="decimal"
                        className={cn(
                          "h-7 w-24 text-right text-xs tabular-nums",
                          short && "border-[var(--sd-data-red)]",
                        )}
                        onChange={(e) =>
                          setBasket((rows) =>
                            rows.map((r) =>
                              r.rowId === b.rowId ? { ...r, qty: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      <span className="ml-1 text-[0.65rem] text-muted-foreground">
                        {s?.uom || ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {s ? (
                        <span
                          className={cn(
                            short
                              ? "font-medium text-[var(--sd-data-red)]"
                              : half
                              ? "text-[var(--sd-data-amber)]"
                              : "text-muted-foreground",
                          )}
                          title={
                            short
                              ? "More than they have."
                              : half
                              ? "More than half their stock — they'll be told, but it won't block the request."
                              : undefined
                          }
                        >
                          {fmtQty(s.on_hand)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-[0.65rem] text-muted-foreground">
                      {s?.store || "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          setBasket((rows) => rows.filter((r) => r.rowId !== b.rowId))
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {overHalfRows.length ? (
          <div className="flex items-start gap-2 rounded-md border border-[var(--sd-data-amber)]/60 bg-[var(--sd-bg-soft)] px-3 py-2 text-xs">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--sd-data-amber)]" />
            <span>
              This takes more than half {lender}'s stock of{" "}
              {overHalfRows.map((r) => r.item_name).join(", ")}. They'll be told
              so they're aware — it won't stop the request.
            </span>
          </div>
        ) : null}

        {shortRows.length ? (
          <div className="flex items-start gap-2 rounded-md border border-[var(--sd-data-red)]/60 px-3 py-2 text-xs">
            <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--sd-data-red)]" />
            <span>
              {shortRows.map((r) => r.item_name).join(", ")} exceed what {lender}{" "}
              has. Reduce the quantity before sending.
            </span>
          </div>
        ) : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Reason (optional)
            </label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why you need it — helps them decide"
              className="h-9 text-xs"
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="h-9 gap-1"
            disabled={!canSubmit}
            onClick={onSubmit}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send to {lender || "…"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RequestList({
  rows,
  role,
  emptyText,
  onDecided,
  pushToast,
}: {
  rows: LoanRequestV2[] | null;
  role: "lender" | "borrower";
  emptyText: string;
  onDecided: () => void | Promise<void>;
  pushToast: (kind: ToastItem["kind"], text: string) => void;
}) {
  if (rows === null) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-md bg-muted/40" />
        ))}
      </div>
    );
  }
  if (!rows.length) {
    return (
      <Card className="p-10 text-center text-sm text-muted-foreground">
        {emptyText}
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => (
        <RequestCard
          key={r.name}
          req={r}
          role={role}
          onDecided={onDecided}
          pushToast={pushToast}
        />
      ))}
    </div>
  );
}

function RequestCard({
  req,
  role,
  onDecided,
  pushToast,
}: {
  req: LoanRequestV2;
  role: "lender" | "borrower";
  onDecided: () => void | Promise<void>;
  pushToast: (kind: ToastItem["kind"], text: string) => void;
}) {
  // Per-line decisions: the lender may approve some and decline others, and may
  // approve less than asked. Seeded from the requested quantity.
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (req.items || []).map((i) => [i.item_code, String(i.requested_qty)]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const pending = (req.items || []).filter((i) => i.status === "Pending");
  const canDecide = role === "lender" && pending.length > 0;

  const decide = async (
    decisions: Array<{ item_code: string; status: "Approved" | "Rejected"; approved_qty?: number }>,
  ) => {
    setBusy(true);
    try {
      const out = await decideLoanItems(req.name, decisions);
      pushToast(
        "ok",
        out.stock_entry
          ? `Transferred — ${out.stock_entry}.`
          : `Request ${out.state.toLowerCase()}.`,
      );
      await onDecided();
    } catch (e) {
      pushToast("err", e instanceof FrappeError ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-3">
      <CardContent className="flex flex-col gap-2 p-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">
            {role === "lender" ? req.requesting_farm : `→ ${req.lender_farm}`}
          </span>
          <Badge variant="outline" className="text-[0.65rem]">
            {summariseLoan(req)}
          </Badge>
          <span className="font-mono text-[0.65rem] text-muted-foreground">
            {req.name}
          </span>
          {req.reason ? (
            <span className="text-xs text-muted-foreground">· {req.reason}</span>
          ) : null}
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Asked</TableHead>
              {canDecide ? (
                <TableHead className="text-right">Give</TableHead>
              ) : (
                <TableHead className="text-right">Approved</TableHead>
              )}
              <TableHead>Status</TableHead>
              {canDecide ? <TableHead className="w-32" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(req.items || []).map((i) => (
              <TableRow key={i.item_code}>
                <TableCell className="text-xs">
                  <div className="font-medium">{i.item_name || i.item_code}</div>
                  {isOverHalf(i) ? (
                    <div className="flex items-center gap-1 text-[0.65rem] text-[var(--sd-data-amber)]">
                      <AlertTriangle className="h-3 w-3" />
                      over half your stock at the time ({fmtQty(i.lender_on_hand ?? 0)})
                    </div>
                  ) : null}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {fmtQty(i.requested_qty)} {i.uom}
                </TableCell>
                <TableCell className="text-right">
                  {canDecide && i.status === "Pending" ? (
                    <Input
                      value={qty[i.item_code] ?? ""}
                      inputMode="decimal"
                      className="h-7 w-20 text-right text-xs tabular-nums"
                      onChange={(e) =>
                        setQty((q) => ({ ...q, [i.item_code]: e.target.value }))
                      }
                    />
                  ) : (
                    <span className="text-xs tabular-nums">
                      {i.status === "Approved" ? fmtQty(i.approved_qty ?? 0) : "—"}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-xs",
                      i.status === "Approved" && "text-[var(--sd-data-green)]",
                      i.status === "Rejected" && "text-muted-foreground",
                    )}
                  >
                    {i.status === "Approved" ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : i.status === "Rejected" ? (
                      <XCircle className="h-3 w-3" />
                    ) : null}
                    {i.status}
                  </span>
                </TableCell>
                {canDecide ? (
                  <TableCell>
                    {i.status === "Pending" ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[0.65rem]"
                          disabled={busy}
                          onClick={() =>
                            decide([
                              {
                                item_code: i.item_code,
                                status: "Approved",
                                approved_qty: Number(qty[i.item_code]),
                              },
                            ])
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[0.65rem]"
                          disabled={busy}
                          onClick={() =>
                            decide([{ item_code: i.item_code, status: "Rejected" }])
                          }
                        >
                          Decline
                        </Button>
                      </div>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {canDecide ? (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await rejectLoanRequest(req.name);
                  pushToast("ok", "Request declined.");
                  await onDecided();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Decline all
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() =>
                decide(
                  pending.map((i) => ({
                    item_code: i.item_code,
                    status: "Approved" as const,
                    approved_qty: Number(qty[i.item_code]),
                  })),
                )
              }
            >
              Approve all
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
