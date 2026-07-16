import { useEffect, useMemo, useRef, useState } from "react";
import {
  Truck,
  RefreshCw,
  Fingerprint,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  UserPlus,
  Search,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/DatePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  bulkAssignEmployee,
  fetchDraftTransfers,
  fetchTransferItems,
  searchEmployees,
  submitWithBiometric,
  type BiometricSubmitResp,
  type BulkAssignResp,
  type EmployeeHit,
  type TransferItem,
  type TransferRow,
} from "@/lib/store-keeper-api";
import { cn } from "@/lib/utils";

const ALL_FARMS = "__all__";

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function SprayPlanTransfers() {
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [farms, setFarms] = useState<string[]>([]);
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BiometricSubmitResp | null>(null);

  // Per-row chemical expansion — fetched on demand the first time a row
  // is opened, cached in this map so subsequent opens are instant.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [itemsByName, setItemsByName] = useState<
    Record<string, TransferItem[] | "loading" | "error">
  >({});

  // Bulk-assign employee picker state.
  const [empQuery, setEmpQuery] = useState("");
  const [empHits, setEmpHits] = useState<EmployeeHit[]>([]);
  const [empOpen, setEmpOpen] = useState(false);
  const [empPicked, setEmpPicked] = useState<EmployeeHit | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [assignResult, setAssignResult] = useState<BulkAssignResp | null>(null);
  const empSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchDraftTransfers({
      from_date: fromDate || undefined,
      to_date: toDate || undefined,
    })
      .then((r) => {
        setRows(r.rows);
        setFarms(r.farms);
        // Drop any selections that no longer exist after a reload.
        setSelected((prev) => {
          const live = new Set(r.rows.map((x) => x.name));
          const next = new Set<string>();
          prev.forEach((n) => live.has(n) && next.add(n));
          return next;
        });
      })
      .catch((e) => setError(e?.message || "Failed to load drafts"))
      .finally(() => setLoading(false));
  };

  // Re-fetch on date-range change. (Farm filter is client-side because
  // the cost is tiny once the rows are in memory.)
  useEffect(load, [fromDate, toDate]);

  // Debounced employee search: type → wait 200ms → query backend.
  useEffect(() => {
    if (!empOpen) return;
    if (empSearchTimer.current) clearTimeout(empSearchTimer.current);
    empSearchTimer.current = setTimeout(() => {
      searchEmployees(empQuery)
        .then(setEmpHits)
        .catch(() => setEmpHits([]));
    }, 200);
    return () => {
      if (empSearchTimer.current) clearTimeout(empSearchTimer.current);
    };
  }, [empQuery, empOpen]);

  const toggleExpand = async (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
    if (itemsByName[name] && itemsByName[name] !== "error") return;
    setItemsByName((prev) => ({ ...prev, [name]: "loading" }));
    try {
      const items = await fetchTransferItems(name);
      setItemsByName((prev) => ({ ...prev, [name]: items }));
    } catch {
      setItemsByName((prev) => ({ ...prev, [name]: "error" }));
    }
  };

  const onAssign = async () => {
    if (!empPicked || selected.size === 0) return;
    setAssigning(true);
    setAssignResult(null);
    try {
      const r = await bulkAssignEmployee(
        Array.from(selected),
        empPicked.employee,
      );
      setAssignResult(r);
      load(); // refresh rows so employee column updates
    } catch (e: any) {
      setError(e?.message || "Bulk assign failed");
    } finally {
      setAssigning(false);
    }
  };

  const visibleRows = useMemo(() => {
    if (farm === ALL_FARMS) return rows;
    return rows.filter((r) => (r.farm || "") === farm);
  }, [rows, farm]);

  const allSelectedHere = useMemo(
    () =>
      visibleRows.length > 0 &&
      visibleRows.every((r) => selected.has(r.name)),
    [visibleRows, selected],
  );

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelectedHere) {
        visibleRows.forEach((r) => next.delete(r.name));
      } else {
        visibleRows.forEach((r) => next.add(r.name));
      }
      return next;
    });
  };

  const toggleOne = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Pre-flight check: every selected row must have exactly one
  // ``custom_employee_data`` row, and they must all be the same
  // employee — one scan, one identity. Surface the issue up-front
  // instead of letting the backend reject every row one-by-one.
  const employeeCheck = useMemo(() => {
    const issues: string[] = [];
    const empSet = new Set<string>();
    let empName = "";
    for (const name of selected) {
      const row = rows.find((r) => r.name === name);
      if (!row) continue;
      if (!row.employees.length) {
        issues.push(`${name}: no employee assigned`);
        continue;
      }
      if (row.employees.length > 1) {
        issues.push(`${name}: ${row.employees.length} employees assigned`);
        continue;
      }
      const e = row.employees[0];
      empSet.add(e.employee);
      empName = e.employee_name;
    }
    if (empSet.size > 1) {
      issues.push(
        `Selected entries belong to ${empSet.size} different employees — pick a set assigned to one person.`,
      );
    }
    return {
      issues,
      employee: empSet.size === 1 ? Array.from(empSet)[0] : "",
      employeeName: empSet.size === 1 ? empName : "",
    };
  }, [selected, rows]);

  const canSubmit =
    selected.size > 0 && !submitting && !employeeCheck.issues.length;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const r = await submitWithBiometric(Array.from(selected));
      setResult(r);
      // Drop submitted rows so a second click doesn't re-submit.
      if (r.ok > 0) {
        setSelected((prev) => {
          const next = new Set(prev);
          for (const item of r.results) {
            if (item.ok) next.delete(item.name);
          }
          return next;
        });
        load();
      }
    } catch (e: any) {
      setError(e?.message || "Submit failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col min-h-svh">
      <PageHeader
        title="Spray Plan Transfers"
        eyebrow="Material Transfer for Manufacture · biometric-authorised bulk submit"
      >
        <div className="flex flex-wrap items-center gap-2">
            <Select value={farm} onValueChange={setFarm}>
              <SelectTrigger aria-label="Farm" className={HEADER_PILL}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FARMS}>All farms</SelectItem>
                {farms.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DatePicker value={fromDate} onChange={setFromDate} />
            <DatePicker value={toDate} onChange={setToDate} />
            <HeaderIconButton
              onClick={load}
              disabled={loading || submitting}
              title="Reload"
            >
              <RefreshCw
                className={cn("h-4 w-4", loading && "animate-spin")}
              />
            </HeaderIconButton>
          </div>
      </PageHeader>

      {/* Action row — bulk-assign + biometric submit live together so the
          store keeper can see the whole flow in one place. */}
      <div className="flex flex-wrap items-end gap-2 border-t pt-3 px-4 md:px-6">
          <div className="flex flex-col gap-1 min-w-72">
            <Label htmlFor="spt-emp">Bulk-assign employee</Label>
            <Popover open={empOpen} onOpenChange={setEmpOpen}>
              <PopoverTrigger asChild>
                <Button
                  id="spt-emp"
                  type="button"
                  variant="outline"
                  className="h-9 justify-between gap-2 font-normal"
                >
                  {empPicked ? (
                    <span className="flex items-center gap-2">
                      <span className="font-medium">
                        {empPicked.employee_name}
                      </span>
                      <span className="text-[0.7rem] text-muted-foreground font-mono">
                        {empPicked.employee}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Search employee…
                    </span>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-2">
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    autoFocus
                    placeholder="Type id, name or designation…"
                    className="h-9 pl-8"
                    value={empQuery}
                    onChange={(e) => setEmpQuery(e.target.value)}
                  />
                </div>
                <ul className="flex flex-col gap-0.5 max-h-72 overflow-y-auto">
                  {empHits.map((e) => (
                    <li key={e.employee}>
                      <button
                        type="button"
                        className="w-full text-left rounded-md px-2 py-1.5 hover:bg-muted text-sm flex flex-col"
                        onClick={() => {
                          setEmpPicked(e);
                          setEmpOpen(false);
                        }}
                      >
                        <span className="font-medium">
                          {e.employee_name}
                        </span>
                        <span className="text-[0.65rem] text-muted-foreground font-mono">
                          {e.employee}
                          {e.designation ? ` · ${e.designation}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                  {!empHits.length && (
                    <li className="text-xs text-muted-foreground px-2 py-3 text-center">
                      No matches.
                    </li>
                  )}
                </ul>
              </PopoverContent>
            </Popover>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={onAssign}
            className="h-9 gap-2"
            disabled={
              !empPicked || selected.size === 0 || assigning || submitting
            }
          >
            {assigning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UserPlus className="h-3.5 w-3.5" />
            )}
            Assign to {selected.size || "selected"}
          </Button>
          <div className="flex-1" />
          <Button
            variant="default"
            size="sm"
            onClick={onSubmit}
            className="h-9 gap-2"
            disabled={!canSubmit}
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Fingerprint className="h-3.5 w-3.5" />
            )}
            Submit {selected.size > 0 ? `(${selected.size})` : "selected"} with biometric
          </Button>
        </div>

      {error && (
        <div className="text-xs text-destructive px-4 md:px-6">{error}</div>
      )}

      <div className="flex-1 px-4 md:px-6 py-4 md:py-6 flex flex-col gap-4">
        {/* Pre-flight panel */}
        {selected.size > 0 && (
          <Card className="border-l-4 border-l-primary/60">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Fingerprint className="h-4 w-4" />
                Ready to scan
              </CardTitle>
              <CardDescription>
                {employeeCheck.employee ? (
                  <>
                    All {selected.size} selected
                    {selected.size === 1 ? " entry is" : " entries are"}{" "}
                    assigned to{" "}
                    <strong>{employeeCheck.employeeName}</strong>. Place
                    their finger on the biometric reader, then click{" "}
                    <em>Submit with biometric</em>.
                  </>
                ) : (
                  <>Resolve the issues below before submitting.</>
                )}
              </CardDescription>
            </CardHeader>
            {employeeCheck.issues.length > 0 && (
              <CardContent className="pt-0">
                <ul className="text-xs text-destructive list-disc pl-5 space-y-0.5">
                  {employeeCheck.issues.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </CardContent>
            )}
          </Card>
        )}

        {/* Bulk-assign result */}
        {assignResult && (
          <Card
            className={cn(
              "border-l-4",
              assignResult.failed > 0
                ? "border-l-destructive"
                : "border-l-[var(--sd-data-cyan,#06b6d4)]",
            )}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <UserPlus className="h-4 w-4" />
                {assignResult.ok} assigned · {assignResult.failed} failed
              </CardTitle>
              <CardDescription>
                <strong>{assignResult.employee.employee_name}</strong>{" "}
                ({assignResult.employee.name}) is now the assigned
                employee on every successful row. Run a biometric scan
                next.
              </CardDescription>
            </CardHeader>
            {assignResult.failed > 0 && (
              <CardContent className="pt-0">
                <ul className="text-xs space-y-1">
                  {assignResult.results
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <li key={r.name}>
                        <span className="font-mono">{r.name}</span> —{" "}
                        <span className="text-destructive">{r.error}</span>
                      </li>
                    ))}
                </ul>
              </CardContent>
            )}
          </Card>
        )}

        {/* Submit result */}
        {result && (
          <Card
            className={cn(
              "border-l-4",
              result.failed > 0
                ? "border-l-destructive"
                : "border-l-[var(--sd-data-green,#16a34a)]",
            )}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                {result.failed > 0 ? (
                  <XCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-[var(--sd-data-green,#16a34a)]" />
                )}
                {result.ok} submitted · {result.failed} failed
              </CardTitle>
              <CardDescription>
                Scanned: <strong>{result.scanned.employee_name}</strong>{" "}
                ({result.scanned.employee})
              </CardDescription>
            </CardHeader>
            {result.failed > 0 && (
              <CardContent className="pt-0">
                <ul className="text-xs space-y-1">
                  {result.results
                    .filter((r) => !r.ok)
                    .map((r) => (
                      <li key={r.name}>
                        <span className="font-mono">{r.name}</span> —{" "}
                        <span className="text-destructive">{r.error}</span>
                      </li>
                    ))}
                </ul>
              </CardContent>
            )}
          </Card>
        )}

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck className="h-4 w-4" />
              Draft transfers
            </CardTitle>
            <CardDescription>
              {visibleRows.length} draft
              {visibleRows.length === 1 ? "" : "s"} ·{" "}
              {farm === ALL_FARMS ? "all farms" : farm}
              {selected.size > 0 ? ` · ${selected.size} selected` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[0.7rem] uppercase tracking-wide text-muted-foreground border-b">
                  <tr>
                    <th className="px-3 py-2 text-left w-10">
                      <Checkbox
                        checked={allSelectedHere}
                        onCheckedChange={toggleAll}
                        aria-label="Select all visible"
                      />
                    </th>
                    <th className="px-2 py-2 w-7"></th>
                    <th className="text-left px-3 py-2">Stock Entry</th>
                    <th className="text-left px-3 py-2">Date</th>
                    <th className="text-left px-3 py-2">Farm</th>
                    <th className="text-left px-3 py-2">Work Order</th>
                    <th className="text-left px-3 py-2">From → To</th>
                    <th className="text-left px-3 py-2">Employee</th>
                    <th className="text-right px-3 py-2">Items</th>
                    <th className="text-right px-3 py-2">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const isSel = selected.has(r.name);
                    const isOpen = expanded.has(r.name);
                    const emp = r.employees[0];
                    const itemsState = itemsByName[r.name];
                    return (
                      <>
                        <tr
                          key={r.name}
                          className={cn(
                            "border-b last:border-0 hover:bg-muted/40 cursor-pointer",
                            isSel && "bg-primary/5",
                          )}
                          onClick={() => toggleOne(r.name)}
                        >
                          <td className="px-3 py-2">
                            <Checkbox
                              checked={isSel}
                              onCheckedChange={() => toggleOne(r.name)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td
                            className="px-2 py-2 text-muted-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpand(r.name);
                            }}
                            title={isOpen ? "Hide chemicals" : "Show chemicals"}
                          >
                            {isOpen ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono text-[0.7rem]">
                            {r.name}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {r.posting_date}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline" className="text-[0.65rem]">
                              {r.farm || "—"}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 font-mono text-[0.7rem] text-muted-foreground">
                            {r.work_order}
                          </td>
                          <td className="px-3 py-2 text-[0.7rem] text-muted-foreground">
                            <div className="truncate max-w-56">
                              {r.from_warehouse}
                            </div>
                            <div className="truncate max-w-56">
                              → {r.to_warehouse}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            {emp ? (
                              <div className="flex flex-col">
                                <span className="text-xs font-medium">
                                  {emp.employee_name}
                                </span>
                                <span className="text-[0.65rem] text-muted-foreground font-mono">
                                  {emp.employee}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[0.7rem] text-destructive">
                                none
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {r.item_count}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium">
                            {fmt(r.total_qty)}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b last:border-0 bg-muted/30">
                            <td colSpan={10} className="px-6 py-3">
                              {itemsState === "loading" ? (
                                <div className="text-xs text-muted-foreground flex items-center gap-2">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  Loading chemicals…
                                </div>
                              ) : itemsState === "error" ? (
                                <div className="text-xs text-destructive">
                                  Failed to load chemicals.
                                </div>
                              ) : !itemsState || !itemsState.length ? (
                                <div className="text-xs text-muted-foreground italic">
                                  No items on this stock entry.
                                </div>
                              ) : (
                                <table className="w-full text-xs">
                                  <thead className="text-[0.65rem] uppercase tracking-wide text-muted-foreground border-b">
                                    <tr>
                                      <th className="text-left px-2 py-1">Chemical</th>
                                      <th className="text-right px-2 py-1">Qty</th>
                                      <th className="text-left px-2 py-1">UoM</th>
                                      <th className="text-left px-2 py-1">From</th>
                                      <th className="text-left px-2 py-1">To</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {itemsState.map((it, i) => (
                                      <tr
                                        key={`${it.item_code}-${i}`}
                                        className="border-b last:border-0"
                                      >
                                        <td className="px-2 py-1">
                                          <div className="font-medium">
                                            {it.item_name}
                                          </div>
                                          <div className="text-[0.6rem] text-muted-foreground font-mono">
                                            {it.item_code}
                                          </div>
                                        </td>
                                        <td className="px-2 py-1 text-right tabular-nums font-medium">
                                          {fmt(it.qty)}
                                        </td>
                                        <td className="px-2 py-1">
                                          {it.uom}
                                        </td>
                                        <td className="px-2 py-1 text-muted-foreground truncate max-w-44">
                                          {it.from_warehouse || "—"}
                                        </td>
                                        <td className="px-2 py-1 text-muted-foreground truncate max-w-44">
                                          {it.to_warehouse || "—"}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                  {!visibleRows.length && (
                    <tr>
                      <td
                        colSpan={10}
                        className="px-4 py-6 text-center text-xs text-muted-foreground"
                      >
                        {loading
                          ? "Loading drafts…"
                          : "No drafts in the current scope."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
