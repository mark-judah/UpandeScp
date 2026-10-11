/**
 * The sprayer register: ID, name, farm, team, role, hours and hazard-weighted
 * hours over 30 days and in total, last exposure. Click a row for exposure per
 * product and the latest sessions.
 *
 * Weighted hours = hours × the product's hazard weight (WHO class I = 4 … IV = 1;
 * an unclassified product counts 2 and is flagged, never read as harmless).
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Info, Loader2, Search, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  fetchSprayerDetail,
  type SprayerDetail,
  type SprayerRow,
  type SprayersPayload,
} from "@/lib/teams-api";

type SortKey =
  | "name"
  | "employee_name"
  | "farm"
  | "spray_team"
  | "role"
  | "hours_30d"
  | "weighted_30d"
  | "hours_total"
  | "weighted_total"
  | "last_exposure";

const COLUMNS: { key: SortKey; label: string; numeric?: boolean; className?: string }[] = [
  { key: "name", label: "ID" },
  { key: "employee_name", label: "Name" },
  { key: "farm", label: "Farm", className: "hidden md:table-cell" },
  { key: "spray_team", label: "Team", className: "hidden lg:table-cell" },
  { key: "role", label: "Role", className: "hidden sm:table-cell" },
  { key: "hours_30d", label: "Hours 30d", numeric: true },
  { key: "weighted_30d", label: "Weighted 30d", numeric: true },
  { key: "hours_total", label: "Hours total", numeric: true, className: "hidden md:table-cell" },
  { key: "weighted_total", label: "Weighted total", numeric: true, className: "hidden md:table-cell" },
  { key: "last_exposure", label: "Last exposure", className: "hidden lg:table-cell" },
];

const hrs = (n: number | null | undefined) =>
  n ? n.toLocaleString(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : "—";

function compare(a: SprayerRow, b: SprayerRow, key: SortKey): number {
  const x = a[key];
  const y = b[key];
  if (typeof x === "number" || typeof y === "number") return (Number(x) || 0) - (Number(y) || 0);
  return String(x ?? "").localeCompare(String(y ?? ""));
}

function SprayerDetailDialog({
  sprayer,
  crop,
  onClose,
}: {
  sprayer: SprayerRow | null;
  crop: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SprayerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sprayer) return;
    let alive = true;
    setDetail(null);
    setError(null);
    fetchSprayerDetail(sprayer.name, crop)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(e?.message || "Failed to load"));
    return () => {
      alive = false;
    };
  }, [sprayer, crop]);

  return (
    <Dialog open={!!sprayer} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {sprayer?.employee_name}{" "}
            <span className="font-mono text-sm font-normal text-muted-foreground">{sprayer?.name}</span>
          </DialogTitle>
          <DialogDescription>
            {[sprayer?.employee, sprayer?.farm, sprayer?.spray_team, sprayer?.role]
              .filter(Boolean)
              .join(" · ")}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!detail && !error && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {detail && (
          <div className="flex flex-col gap-5">
            <section>
              <h3 className="mb-2 text-sm font-semibold">Exposure per product</h3>
              <Table aria-label="Exposure per product">
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Toxicity</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                    <TableHead className="text-right">Weighted</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.products.map((p) => (
                    <TableRow key={p.spray_product || p.product_name}>
                      <TableCell>{p.product_name}</TableCell>
                      <TableCell>
                        {p.toxicity ? (
                          <Badge variant="secondary">Class {p.toxicity}</Badge>
                        ) : (
                          <Badge variant="outline" className="text-amber-700 dark:text-amber-500">
                            Unknown
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{p.sessions}</TableCell>
                      <TableCell className="text-right tabular-nums">{hrs(p.hours)}</TableCell>
                      <TableCell className="text-right tabular-nums">{hrs(p.weighted_hours)}</TableCell>
                    </TableRow>
                  ))}
                  {!detail.products.length && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-4 text-center text-sm text-muted-foreground">
                        No recorded exposure.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </section>
            <section>
              <h3 className="mb-2 text-sm font-semibold">Latest sessions</h3>
              <Table aria-label="Latest sessions">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Greenhouse</TableHead>
                    <TableHead className="hidden sm:table-cell">Role · PPE</TableHead>
                    <TableHead className="hidden md:table-cell">Products</TableHead>
                    <TableHead className="text-right">Hours</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.sessions.map((s) => (
                    <TableRow key={s.logsheet}>
                      <TableCell className="whitespace-nowrap">
                        {s.date}
                        <div className="font-mono text-xs text-muted-foreground">{s.logsheet}</div>
                      </TableCell>
                      <TableCell>{s.greenhouse || "—"}</TableCell>
                      <TableCell className="hidden text-sm sm:table-cell">
                        {s.role}
                        {s.ppe_condition ? ` · ${s.ppe_condition}` : ""}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                        {s.products}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.flags?.includes("no duration") ? (
                          <span title="No start/stop time recorded" className="text-amber-700 dark:text-amber-500">
                            no time
                          </span>
                        ) : (
                          hrs(s.hours)
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SprayersTab({ data, crop }: { data: SprayersPayload; crop: string }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "weighted_30d", dir: -1 });
  const [open, setOpen] = useState<SprayerRow | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (r: SprayerRow) =>
      !needle ||
      [r.name, r.employee, r.employee_name, r.farm, r.spray_team, r.role]
        .some((v) => (v || "").toLowerCase().includes(needle));
    return data.sprayers
      .filter(hit)
      .sort((a, b) => sort.dir * compare(a, b, sort.key));
  }, [data.sprayers, q, sort]);

  const toggle = (key: SortKey, numeric?: boolean) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: numeric ? -1 : 1 }));

  const { flags } = data;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            aria-label="Search sprayers"
            placeholder="Search ID, name, farm, team"
            className="pl-8"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            <span className="font-medium tabular-nums text-foreground">{rows.length}</span> sprayers
          </span>
          {flags.no_duration > 0 && (
            <span className="flex items-center gap-1" title="Logsheets with no start/stop time: counted as 0 h">
              <TriangleAlert className="h-3.5 w-3.5 text-amber-600" />
              <span className="tabular-nums">{flags.no_duration}</span> rows with no duration
            </span>
          )}
          {flags.hazard_unknown > 0 && (
            <span
              className="flex items-center gap-1"
              title="Products with no toxicity class on their Spray Product: weighted 2 until classified"
            >
              <Info className="h-3.5 w-3.5" />
              <span className="tabular-nums">{flags.products_unclassified}</span> products lack a hazard class
            </span>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table aria-label="Sprayers">
            <TableHeader>
              <TableRow>
                {COLUMNS.map((c) => (
                  <TableHead
                    key={c.key}
                    className={`${c.className || ""} ${c.numeric ? "text-right" : ""}`}
                    aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      onClick={() => toggle(c.key, c.numeric)}
                    >
                      {c.label}
                      {sort.key === c.key &&
                        (sort.dir === 1 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.name}
                  className="cursor-pointer"
                  onClick={() => setOpen(r)}
                  data-testid={`sprayer-${r.name}`}
                >
                  <TableCell className="font-mono text-xs">{r.name}</TableCell>
                  <TableCell>
                    <span className="font-medium">{r.employee_name}</span>
                    {r.status === "Inactive" && (
                      <Badge variant="outline" className="ml-2">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{r.farm || "—"}</TableCell>
                  <TableCell className="hidden lg:table-cell">{r.spray_team || "—"}</TableCell>
                  <TableCell className="hidden sm:table-cell">{r.role}</TableCell>
                  <TableCell className="text-right tabular-nums">{hrs(r.hours_30d)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{hrs(r.weighted_30d)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{hrs(r.hours_total)}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{hrs(r.weighted_total)}</TableCell>
                  <TableCell className="hidden whitespace-nowrap lg:table-cell">{r.last_exposure || "—"}</TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={COLUMNS.length} className="py-8 text-center text-sm text-muted-foreground">
                    No sprayers match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <SprayerDetailDialog sprayer={open} crop={crop} onClose={() => setOpen(null)} />
    </div>
  );
}
