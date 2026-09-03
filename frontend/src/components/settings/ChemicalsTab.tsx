/**
 * Chemicals tab — paginated, searchable list of Item rows in the
 * Chemical / Fertilizer item groups. Inline toggle for enabled +
 * rate-range edit; everything else (codes, targets, ingredients)
 * lives in the edit drawer to keep the table density usable.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Beaker,
  ChevronLeft,
  ChevronRight,
  Leaf,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchChemicals,
  fetchCodes,
  fetchTargets,
  saveChemical,
  type ChemicalKind,
  type ChemicalRow,
  type ChemicalsResponse,
  type CodesResponse,
  type TargetsResponse,
} from "@/lib/settings-api";
import { errorText } from "@/lib/errors";
import { ChemicalEditDrawer } from "./ChemicalEditDrawer";

const PAGE_SIZE = 30;

type KindFilter = "" | ChemicalKind;

export function ChemicalsTab() {
  const [query, setQuery] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [kindFilter, setKindFilter] = useState<KindFilter>("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ChemicalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reference catalogs (loaded once, drive the edit drawer pickers).
  const [codes, setCodes] = useState<CodesResponse | null>(null);
  const [targets, setTargets] = useState<TargetsResponse | null>(null);

  // Drawer state.
  const [editing, setEditing] = useState<ChemicalRow | null>(null);

  // Inline-rate edit state — keyed by item_code so the rest of the
  // table doesn't re-render on every keystroke.
  const [savingCode, setSavingCode] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchCodes(), fetchTargets()])
      .then(([c, t]) => {
        setCodes(c);
        setTargets(t);
      })
      .catch(() => {
        // Non-fatal — the table still works, the drawer just can't pick.
      });
  }, []);

  const load = (overrides?: {
    page?: number;
    query?: string;
    only_enabled?: boolean;
    kind?: KindFilter;
  }) => {
    setLoading(true);
    setError(null);
    fetchChemicals({
      query: overrides?.query ?? query,
      page: overrides?.page ?? page,
      page_size: PAGE_SIZE,
      only_enabled: overrides?.only_enabled ?? onlyEnabled,
      kind: overrides?.kind ?? kindFilter,
    })
      .then((r) => setData(r))
      .catch((e) =>
        setError(errorText(e)),
      )
      .finally(() => setLoading(false));
  };

  // Initial load + reload on filter change with debounce.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      load({ page: 1 });
      setPage(1);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, onlyEnabled, kindFilter]);

  // Page change.
  useEffect(() => {
    load({ page });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.page_size));
  }, [data]);

  const toggleEnabled = async (row: ChemicalRow, next: boolean) => {
    setSavingCode(row.item_code);
    try {
      await saveChemical(row.item_code, { enabled: next });
      setData((d) =>
        d
          ? {
              ...d,
              items: d.items.map((r) =>
                r.item_code === row.item_code
                  ? { ...r, enabled: next, disabled: next ? 0 : 1 }
                  : r,
              ),
            }
          : d,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSavingCode(null);
    }
  };

  const onDrawerSaved = (updated: ChemicalRow) => {
    setData((d) =>
      d
        ? {
            ...d,
            items: d.items.map((r) =>
              r.item_code === updated.item_code ? updated : r,
            ),
          }
        : d,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Chemicals & fertilizers</CardTitle>
          <CardDescription>
            Items in the chemical / fertilizer groups. Toggle a row to
            include it in the spray-plan picker. Click <b>Edit</b> for rate
            range, IRAC / FRAC / GHS codes, active ingredients, and the
            list of pests / diseases this chemical treats.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, code, or description…"
                className="pl-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="inline-flex rounded-full border bg-card p-1 text-[0.7rem] gap-0.5">
              <KindFilterButton
                active={kindFilter === ""}
                onClick={() => setKindFilter("")}
                icon={<Sparkles className="h-3 w-3" />}
                label="All"
              />
              <KindFilterButton
                active={kindFilter === "chemical"}
                onClick={() => setKindFilter("chemical")}
                icon={<Beaker className="h-3 w-3" />}
                label="Chemicals"
                tone="rose"
              />
              <KindFilterButton
                active={kindFilter === "fertilizer"}
                onClick={() => setKindFilter("fertilizer")}
                icon={<Leaf className="h-3 w-3" />}
                label="Fertilizers"
                tone="emerald"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="only_enabled"
                checked={onlyEnabled}
                onCheckedChange={(v) => setOnlyEnabled(!!v)}
              />
              <Label htmlFor="only_enabled" className="text-xs cursor-pointer">
                Only enabled
              </Label>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums ml-auto">
              {loading
                ? "Loading…"
                : data
                  ? `${data.total} matching item${data.total === 1 ? "" : "s"}`
                  : "—"}
            </span>
          </div>
          {error && (
            <div className="text-xs text-destructive">{error}</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading && !data ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading chemicals…
            </div>
          ) : !data?.items.length ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No items match.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20 text-center">Enabled</TableHead>
                  <TableHead>Chemical</TableHead>
                  <TableHead className="w-32">Class</TableHead>
                  <TableHead className="w-24 text-center">Hazard</TableHead>
                  <TableHead className="w-32 text-right">Rate (per 1000L)</TableHead>
                  <TableHead>Codes</TableHead>
                  <TableHead className="w-20 text-right">Targets</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow
                    key={r.item_code}
                    className={r.enabled ? "" : "opacity-60"}
                  >
                    <TableCell className="text-center">
                      <div className="inline-flex items-center justify-center">
                        <Checkbox
                          checked={r.enabled}
                          onCheckedChange={(v) => toggleEnabled(r, !!v)}
                          disabled={savingCode === r.item_code}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <KindIcon kind={r.kind} />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold truncate">
                            {r.item_name || r.item_code}
                          </div>
                          <div className="text-[0.65rem] text-muted-foreground font-mono tabular-nums truncate">
                            #{r.item_code} · {r.item_group}
                            {r.stock_uom ? ` · ${r.stock_uom}` : ""}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {r.kind === "fertilizer" ? (
                        <span className="text-[0.65rem] text-muted-foreground italic">
                          —
                        </span>
                      ) : (
                        <ClassBadge value={r.custom_type} />
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <ToxicityBadge value={r.custom_toxicity} />
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      <RateRange
                        lower={r.custom_lower_rate_limit}
                        upper={r.custom_upper_rate_limit}
                      />
                      {r.custom_reentry_interval_hrs ? (
                        <div className="text-[0.6rem] text-muted-foreground mt-0.5">
                          REI {r.custom_reentry_interval_hrs}h
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.irac.map((c) => (
                          <span
                            key={`i-${c}`}
                            className="text-[0.6rem] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          >
                            IRAC {c}
                          </span>
                        ))}
                        {r.frac.map((c) => (
                          <span
                            key={`f-${c}`}
                            className="text-[0.6rem] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                          >
                            FRAC {c}
                          </span>
                        ))}
                        {r.ghs.map((c) => (
                          <span
                            key={`g-${c}`}
                            className="text-[0.6rem] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                          >
                            GHS {c}
                          </span>
                        ))}
                        {r.irac.length + r.frac.length + r.ghs.length === 0 && (
                          <span className="text-[0.65rem] text-muted-foreground italic">
                            no codes
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.kind === "fertilizer" ? (
                        <span className="text-[0.65rem] text-muted-foreground italic">
                          n/a
                        </span>
                      ) : r.targets.length > 0 ? (
                        <span className="text-[0.65rem] font-semibold tabular-nums bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                          {r.targets.length}
                        </span>
                      ) : (
                        <span className="text-[0.65rem] text-muted-foreground italic">
                          none
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-[0.7rem]"
                        onClick={() => setEditing(r)}
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {data && data.total > data.page_size && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {data.page} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <ChemicalEditDrawer
        open={!!editing}
        onClose={() => setEditing(null)}
        chemical={editing}
        codes={codes}
        targets={targets}
        onSaved={onDrawerSaved}
      />
    </div>
  );
}

const CLASS_STYLES: Record<string, string> = {
  Insecticide: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-200",
  Fungicide: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200",
  Adjuvant: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200",
  "pH Buffer": "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-200",
};

function ClassBadge({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-[0.65rem] text-muted-foreground italic">—</span>;
  }
  return (
    <span
      className={
        "inline-flex items-center px-2 py-0.5 text-[0.65rem] font-semibold rounded-full border " +
        (CLASS_STYLES[value] || "bg-muted text-foreground border-border")
      }
    >
      {value}
    </span>
  );
}

/** WHO hazard classification badge. I is most toxic (red), IV is least (green). */
function ToxicityBadge({ value }: { value: string | null }) {
  if (!value) {
    return <span className="text-[0.65rem] text-muted-foreground italic">—</span>;
  }
  const style: Record<string, { cls: string; title: string }> = {
    I:   { cls: "bg-red-600 text-white",          title: "I · Extremely hazardous" },
    II:  { cls: "bg-orange-500 text-white",       title: "II · Highly hazardous" },
    III: { cls: "bg-yellow-400 text-yellow-900",  title: "III · Slightly hazardous" },
    IV:  { cls: "bg-emerald-500 text-white",      title: "IV · Unlikely to cause harm" },
  };
  const s = style[value] || { cls: "bg-muted text-foreground", title: value };
  return (
    <span
      title={s.title}
      className={
        "inline-flex items-center justify-center min-w-7 h-5 px-2 rounded text-[0.62rem] font-bold tracking-wider " +
        s.cls
      }
    >
      {value}
    </span>
  );
}

/** Pill-style filter button used for the All / Chemicals / Fertilizers
 *  segmented control. Tinted by tone when active so the user immediately
 *  sees which slice they're looking at. */
function KindFilterButton({
  active,
  onClick,
  icon,
  label,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone?: "rose" | "emerald";
}) {
  const activeTone =
    tone === "rose"
      ? "bg-rose-500 text-white"
      : tone === "emerald"
        ? "bg-emerald-600 text-white"
        : "bg-primary text-primary-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 px-3 py-1 rounded-full font-medium transition-colors " +
        (active
          ? activeTone
          : "text-muted-foreground hover:text-foreground hover:bg-muted/60")
      }
    >
      {icon}
      {label}
    </button>
  );
}

/** Round-tinted icon shown beside each row's name — at-a-glance Chemical
 *  vs Fertilizer indicator without taking up a column. */
function KindIcon({ kind }: { kind: ChemicalKind }) {
  if (kind === "fertilizer") {
    return (
      <span
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
        title="Fertilizer"
        aria-label="Fertilizer"
      >
        <Leaf className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-200"
      title="Chemical"
      aria-label="Chemical"
    >
      <Beaker className="h-3.5 w-3.5" />
    </span>
  );
}

function RateRange({
  lower,
  upper,
}: {
  lower: number | null;
  upper: number | null;
}) {
  if (!lower && !upper) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span>
      {lower ?? "—"}
      <span className="mx-1 text-muted-foreground">·</span>
      {upper ?? "—"}
    </span>
  );
}
