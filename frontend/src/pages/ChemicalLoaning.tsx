/**
 * Chemical Loaning — a farm's Spray Plan Creator builds a cart of chemicals
 * (each split across up to 5 lender farms) and requests them from another
 * farm; source farms approve from the Inbox. Reads/writes via
 * lib/loaning-api.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  ArrowRightLeft,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  PackageCheck,
  ShoppingCart,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HEADER_PILL } from "@/components/header-controls";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { cn } from "@/lib/utils";
import {
  fetchMyFarms,
  fetchLoanableChemicals,
  fetchSourcesFor,
  listRequests,
  createRequests,
  getCreditors,
  approveSource,
  rejectRequest,
  type LoanableChemical,
  type LoanSource,
  type LoanRequest,
  type LoanCartItem,
  type CreditorRow,
  type RequestState,
} from "@/lib/loaning-api";

const MAX_SOURCES = 5;

const STATE_TONE: Record<RequestState, string> = {
  Draft: "bg-muted text-muted-foreground",
  "Pending Approval": "bg-amber-500/15 text-amber-600",
  Approved: "bg-sky-500/15 text-sky-600",
  Fulfilled: "bg-emerald-500/15 text-emerald-600",
  Rejected: "bg-[var(--sd-data-red)]/15 text-[var(--sd-data-red)]",
  Expired: "bg-muted text-muted-foreground",
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ""));

export function ChemicalLoaning() {
  const [farms, setFarms] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [farm, setFarm] = useState<string>("");
  const [tab, setTab] = useState<"request" | "inbox" | "creditors">("request");
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    fetchMyFarms()
      .then((r) => {
        setFarms(r.farms);
        setEnabled(r.enabled);
        setFarm((f) => f || r.farms[0] || "");
      })
      .catch(() => setFarms([]))
      .finally(() => setBooting(false));
  }, []);

  return (
    <div className="flex flex-col min-h-svh">
      <PageHeader
        title="Chemical Loaning"
        eyebrow="Borrow a chemical you're short on from another farm"
      >
        {farms.length > 0 && (
          <Select value={farm} onValueChange={setFarm}>
            <SelectTrigger aria-label="Your farm" className={HEADER_PILL}>
              <SelectValue placeholder="Your farm" />
            </SelectTrigger>
            <SelectContent>
              {farms.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </PageHeader>

      <div className="px-4 md:px-6 pt-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="request">Request</TabsTrigger>
            <TabsTrigger value="inbox">Inbox</TabsTrigger>
            <TabsTrigger value="creditors">Creditors</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="px-4 md:px-6 py-4 flex-1">
        {booting ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !enabled ? (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="p-6 text-sm text-amber-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Chemical loaning is turned off. Ask the General Manager to enable it
              in Settings → Spray Plan.
            </CardContent>
          </Card>
        ) : !farm ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              You are not assigned to any farm.
            </CardContent>
          </Card>
        ) : tab === "request" ? (
          <RequestTab farm={farm} />
        ) : tab === "inbox" ? (
          <InboxTab />
        ) : (
          <CreditorsTab farm={farm} />
        )}
      </div>
    </div>
  );
}

// ── Request tab ─────────────────────────────────────────────────────
function RequestTab({ farm }: { farm: string }) {
  const [chemicals, setChemicals] = useState<LoanableChemical[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<LoanableChemical | null>(null);
  const [cart, setCart] = useState<LoanCartItem[]>([]);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [result, setResult] = useState<{
    names: string[];
    failed: { item_code: string; error: string }[];
  } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setPicked(null);
    fetchLoanableChemicals(farm)
      .then(setChemicals)
      .catch(() => setChemicals([]))
      .finally(() => setLoading(false));
  }, [farm]);

  useEffect(load, [load]);

  // Cart is per-farm state — reset it whenever the acting farm changes.
  useEffect(() => {
    setCart([]);
    setReason("");
    setResult(null);
    setSubmitErr(null);
  }, [farm]);

  const nameFor = (itemCode: string) =>
    chemicals.find((c) => c.item_code === itemCode)?.item_name || itemCode;

  const addToCart = (item: LoanCartItem) => {
    setCart((prev) => [...prev, item]);
    setPicked(null);
    setResult(null);
  };

  const removeFromCart = (idx: number) =>
    setCart((prev) => prev.filter((_, i) => i !== idx));

  const submitCart = async () => {
    setSubmitErr(null);
    setResult(null);
    if (!cart.length) return;
    setSubmitting(true);
    try {
      const res = await createRequests({
        requesting_farm: farm,
        reason: reason.trim() || undefined,
        items: cart,
      });
      setResult(res);
      if (res.failed.length) {
        const failedCodes = new Set(res.failed.map((f) => f.item_code));
        setCart((prev) => prev.filter((c) => failedCodes.has(c.item_code)));
      } else {
        setCart([]);
        setReason("");
      }
    } catch (e: any) {
      setSubmitErr(e?.message || "Could not submit the request.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking your stock…
      </div>
    );
  }

  if (picked) {
    return (
      <SourcePicker
        farm={farm}
        chem={picked}
        onBack={() => setPicked(null)}
        onAdd={addToCart}
      />
    );
  }

  return (
    <div className="space-y-4">
      {cart.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShoppingCart className="h-4 w-4 text-primary" />
              Request cart ({cart.length})
            </div>
            <div className="rounded-md border divide-y">
              {cart.map((item, idx) => (
                <div
                  key={`${item.item_code}-${idx}`}
                  className="flex items-center justify-between gap-3 px-3 py-2"
                >
                  <div className="text-sm">
                    <span className="font-medium">{nameFor(item.item_code)}</span>{" "}
                    <span className="text-muted-foreground text-xs">
                      · {fmt(item.requested_qty)} {item.uom} from{" "}
                      {item.sources
                        .map((s) => `${s.source_farm} (${fmt(s.qty)})`)
                        .join(", ")}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-destructive hover:text-destructive"
                    onClick={() => removeFromCart(idx)}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                placeholder="Reason (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-8 flex-1 min-w-40"
              />
              <Button onClick={submitCart} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRightLeft className="h-4 w-4" />
                )}
                Submit request
              </Button>
            </div>
            {submitErr && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {submitErr}
              </div>
            )}
            {result && (
              <div className="space-y-1 text-xs">
                {result.names.length > 0 && (
                  <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-emerald-700 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Sent {result.names.length} request
                    {result.names.length === 1 ? "" : "s"} for approval.
                  </div>
                )}
                {result.failed.length > 0 && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
                    {result.failed.map((f) => (
                      <div key={f.item_code}>
                        {nameFor(f.item_code)}: {f.error}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="p-0">
        <CardContent className="p-0">
          <div className="flex items-center justify-between px-4 py-2 border-b">
            <span className="text-sm font-medium">
              Chemicals available to request ({chemicals.length})
            </span>
            <Button variant="ghost" size="sm" onClick={load} className="h-7 gap-1">
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
          {chemicals.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No chemicals found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chemical</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                  <TableHead className="text-right">Baseline</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {chemicals.map((c) => (
                  <TableRow key={c.item_code}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{c.item_name}</div>
                      <div className="text-muted-foreground font-mono text-[0.65rem]">
                        {c.item_code}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {fmt(c.on_hand)} {c.uom}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                      {c.baseline_qty != null ? fmt(c.baseline_qty) : "—"}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" className="h-7" onClick={() => setPicked(c)}>
                        Request
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Source picker / split ───────────────────────────────────────────
function SourcePicker({
  farm,
  chem,
  onBack,
  onAdd,
}: {
  farm: string;
  chem: LoanableChemical;
  onBack: () => void;
  onAdd: (item: LoanCartItem) => void;
}) {
  const [sources, setSources] = useState<LoanSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchSourcesFor(farm, chem.item_code)
      .then(setSources)
      .catch((e) => setErr(e?.message || "Failed to load sources"))
      .finally(() => setLoading(false));
  }, [farm, chem.item_code]);

  const selectedFarms = Object.keys(sel);
  const total = useMemo(
    () => Object.values(sel).reduce((a, b) => a + (b || 0), 0),
    [sel],
  );

  const toggle = (s: LoanSource) => {
    setSel((prev) => {
      const next = { ...prev };
      if (s.source_farm in next) {
        delete next[s.source_farm];
      } else {
        if (Object.keys(next).length >= MAX_SOURCES) return prev;
        next[s.source_farm] = 0;
      }
      return next;
    });
  };

  const setQty = (sf: string, q: number) =>
    setSel((prev) => ({ ...prev, [sf]: q }));

  const addToCart = () => {
    setErr(null);
    if (!selectedFarms.length) {
      setErr("Pick at least one source farm.");
      return;
    }
    if (total <= 0) {
      setErr("Enter the quantity to request from each source.");
      return;
    }
    onAdd({
      item_code: chem.item_code,
      uom: chem.uom,
      requested_qty: total,
      sources: selectedFarms.map((sf) => ({ source_farm: sf, qty: sel[sf] })),
    });
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7" onClick={onBack}>
            ← Back
          </Button>
          <div className="text-sm">
            Borrow <span className="font-semibold">{chem.item_name}</span> for{" "}
            <span className="font-semibold">{farm}</span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Finding farms with
            surplus…
          </div>
        ) : sources.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No other farm has lendable stock of this chemical right now.
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              Pick up to {MAX_SOURCES} source farms and split the quantity.
              Ranked by how much each can spare.
            </div>
            <div className="rounded-md border divide-y">
              {sources.map((s) => {
                const on = s.source_farm in sel;
                return (
                  <div
                    key={s.source_farm}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2",
                      on && "bg-primary/5",
                    )}
                  >
                    <Button
                      variant={on ? "default" : "outline"}
                      size="sm"
                      className="h-7 w-20"
                      onClick={() => toggle(s)}
                      disabled={!on && selectedFarms.length >= MAX_SOURCES}
                    >
                      {on ? "Selected" : "Pick"}
                    </Button>
                    <div className="flex-1 text-sm">
                      <span className="font-medium">{s.source_farm}</span>
                      <span className="text-muted-foreground text-xs">
                        {" "}· can spare {fmt(s.lendable)} {chem.uom}
                      </span>
                    </div>
                    {on && (
                      <Input
                        type="number"
                        min={0}
                        max={s.lendable}
                        step="0.1"
                        value={sel[s.source_farm] || ""}
                        placeholder="Qty"
                        onChange={(e) =>
                          setQty(s.source_farm, Number(e.target.value) || 0)
                        }
                        className="h-8 w-28"
                      />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between">
              <div className="text-sm">
                Total requested:{" "}
                <span className="font-semibold tabular-nums">
                  {fmt(total)} {chem.uom}
                </span>
              </div>
              <Button onClick={addToCart} disabled={total <= 0}>
                <ArrowRightLeft className="h-4 w-4" />
                Add to request
              </Button>
            </div>
          </>
        )}

        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {err}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Inbox tab ───────────────────────────────────────────────────────
function InboxTab() {
  const [incoming, setIncoming] = useState<LoanRequest[]>([]);
  const [mine, setMine] = useState<LoanRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([listRequests("incoming"), listRequests("mine")])
      .then(([inc, m]) => {
        setIncoming(inc);
        setMine(m);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, key: string) => {
    setBusy(key);
    try {
      await fn();
      load();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading inbox…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <PackageCheck className="h-4 w-4 text-primary" />
          Awaiting my approval ({incoming.length})
        </h2>
        {incoming.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              No requests waiting on your farms.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {incoming.map((r) => (
              <Card key={r.name}>
                <CardContent className="p-3 flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-0 text-sm">
                    <span className="font-medium">{r.item_name}</span> —{" "}
                    <span className="font-semibold">
                      {fmt(r.requested_qty)} {r.uom}
                    </span>{" "}
                    to <span className="font-medium">{r.requesting_farm}</span>
                    <div className="text-xs text-muted-foreground">
                      {r.sources
                        .map((s) => `${s.source_farm}: ${fmt(s.qty)}${s.approved ? " ✓" : ""}`)
                        .join(" · ")}
                      {" · "}
                      {r.name}
                    </div>
                  </div>
                  {r.sources
                    .filter((s) => !s.approved)
                    .map((s) => (
                      <div key={s.source_farm} className="flex items-center gap-2">
                        <Button
                          size="sm"
                          className="h-7"
                          disabled={!!busy}
                          onClick={() =>
                            act(() => approveSource(r.name, s.source_farm), r.name + s.source_farm)
                          }
                        >
                          {busy === r.name + s.source_farm ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          Approve {s.source_farm}
                        </Button>
                      </div>
                    ))}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-destructive hover:text-destructive"
                    disabled={!!busy}
                    onClick={() => act(() => rejectRequest(r.name), r.name + "rej")}
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">My requests ({mine.length})</h2>
        {mine.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              You haven't raised any requests.
            </CardContent>
          </Card>
        ) : (
          <Card className="p-0">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Request</TableHead>
                    <TableHead>Chemical</TableHead>
                    <TableHead>Sources</TableHead>
                    <TableHead>State</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mine.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell className="text-xs font-mono">{r.name}</TableCell>
                      <TableCell className="text-xs">
                        {r.item_name}
                        <span className="text-muted-foreground">
                          {" "}· {fmt(r.requested_qty)} {r.uom}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.sources.map((s) => s.source_farm).join(", ")}
                      </TableCell>
                      <TableCell>
                        <Badge className={cn("text-[0.6rem]", STATE_TONE[r.workflow_state])}>
                          {r.workflow_state}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

// ── Creditors tab ───────────────────────────────────────────────────
function CreditorsTab({ farm }: { farm: string }) {
  const [rows, setRows] = useState<CreditorRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getCreditors(farm)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [farm]);

  useEffect(load, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading creditors…
      </div>
    );
  }

  return (
    <Card className="p-0">
      <CardContent className="p-0">
        <div className="flex items-center justify-between px-4 py-2 border-b">
          <span className="text-sm font-medium">
            Farms {farm} owes chemicals to ({rows.length})
          </span>
          <Button variant="ghost" size="sm" onClick={load} className="h-7 gap-1">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        {rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No outstanding chemical loans.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Chemical</TableHead>
                <TableHead>Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.creditor_farm}-${r.item_code}-${i}`}>
                  <TableCell className="text-xs font-medium">{r.item_name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    received {fmt(r.qty)} {r.uom} of{" "}
                    <span className="font-medium text-foreground">{r.item_name}</span> from{" "}
                    <span className="font-medium text-foreground">{r.creditor_farm}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
