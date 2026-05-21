import { useEffect, useMemo, useState } from "react";
import {
  Truck,
  RefreshCw,
  Fingerprint,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchDraftTransfers,
  submitWithBiometric,
  type BiometricSubmitResp,
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BiometricSubmitResp | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchDraftTransfers()
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

  useEffect(load, []);

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
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Spray Plan Transfers
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Material Transfer for Manufacture · biometric-authorised bulk submit
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-44">
              <Label htmlFor="spt-farm">Farm</Label>
              <Select value={farm} onValueChange={setFarm}>
                <SelectTrigger id="spt-farm" className="h-9">
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
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={load}
              className="h-9 gap-2"
              disabled={loading || submitting}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              />
              Reload
            </Button>
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
        </div>

        {error && (
          <div className="text-xs text-destructive">{error}</div>
        )}
      </header>

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
                    const emp = r.employees[0];
                    return (
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
                    );
                  })}
                  {!visibleRows.length && (
                    <tr>
                      <td
                        colSpan={9}
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
