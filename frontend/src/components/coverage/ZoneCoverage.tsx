/**
 * Zone coverage table for the Coverage page: per greenhouse and ISO week, the
 * share of its zones scouted (Full above 80 %, else Partial), beds scouted, how
 * often each bed was keyed, and the beds that fell short. A row opens to the
 * week's days and the worst beds.
 */
import { Fragment, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { FilterSelect } from "@/components/FilterSelect";
import { TableRowsSkeleton } from "@/components/Loading";
import { fetchZoneCoverage, type ZoneCoveragePayload, type ZoneRow, type ZoneStatus } from "@/lib/zone-coverage-api";
import { errorText } from "@/lib/errors";
import { cn } from "@/lib/utils";

const TONE: Record<ZoneStatus, string> = {
  Full: "var(--sd-data-green)",
  Partial: "var(--sd-data-amber)",
  "Not scouted": "var(--sd-data-red)",
};

export function weekLabel(start: string, end: string): string {
  const f = (s: string) =>
    new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${f(start)} to ${f(end)}`;
}

function StatusPill({ status }: { status: ZoneStatus }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.65rem] font-medium"
      style={{ color: TONE[status], borderColor: TONE[status] }}
    >
      {status}
    </span>
  );
}

function Detail({ row }: { row: ZoneRow }) {
  return (
    <div className="grid gap-4 py-2 md:grid-cols-2">
      <div>
        <div className="mb-1 text-[0.7rem] font-medium text-muted-foreground">By day</div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-0.5 font-normal">Day</th>
              <th className="py-0.5 text-right font-normal">Entries</th>
              <th className="py-0.5 text-right font-normal">Beds</th>
              <th className="py-0.5 text-right font-normal">Zones</th>
            </tr>
          </thead>
          <tbody>
            {row.days.map((d) => (
              <tr key={d.date}>
                <td className="py-0.5">
                  {new Date(`${d.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                </td>
                <td className="py-0.5 text-right tabular-nums">{d.entries || "—"}</td>
                <td className="py-0.5 text-right tabular-nums">{d.beds || "—"}</td>
                <td className="py-0.5 text-right tabular-nums">{d.zones || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="mb-1 text-[0.7rem] font-medium text-muted-foreground">
          Under-scouted beds ({row.beds_under ?? 0}), worst first
        </div>
        {row.under.length ? (
          <ul className="text-xs">
            {row.under.map((b) => (
              <li key={b.bed} className="flex justify-between gap-3 py-0.5">
                <span>{b.bed}</span>
                <span className="tabular-nums text-muted-foreground">
                  {b.zones} zones · {b.pct}% · keyed {b.entries}x
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Every bed reached its share of zones.</p>
        )}
      </div>
    </div>
  );
}

export function ZoneCoverage({
  crop, farm, greenhouse, from, to,
}: { crop: string; farm: string; greenhouse: string; from: string; to: string }) {
  const [data, setData] = useState<ZoneCoveragePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [week, setWeek] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchZoneCoverage({ crop, farm, greenhouse, from_date: from, to_date: to })
      .then((d) => {
        if (!live) return;
        setData(d);
        setWeek((cur) => (d.weeks.some((w) => w.week_start === cur) ? cur : d.weeks.at(-1)?.week_start ?? ""));
      })
      .catch((e) => live && setError(errorText(e, "Could not load the zone coverage.")))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [crop, farm, greenhouse, from, to]);

  const w = data?.weeks.find((x) => x.week_start === week);
  const rows = (w?.rows ?? []).slice().sort((a, b) => {
    const rank = (s: ZoneStatus) => (s === "Not scouted" ? 0 : s === "Partial" ? 1 : 2);
    return rank(a.status) - rank(b.status) || (a.zone_pct ?? 0) - (b.zone_pct ?? 0) || a.house.localeCompare(b.house);
  });
  const labels = Object.fromEntries((data?.weeks ?? []).map((x) => [x.week_start, weekLabel(x.week_start, x.week_end)]));

  return (
    <Card data-testid="zone-coverage">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Zone coverage</CardTitle>
          <CardDescription>
            Share of each greenhouse's zones scouted in the week. Full above {data?.full_pct ?? 80}%, otherwise
            Partial; a bed is under-scouted below {data?.full_pct ?? 80}% of its zones.
          </CardDescription>
        </div>
        {data && data.weeks.length > 0 && (
          <FilterSelect
            label="Zone coverage week"
            value={week}
            onChange={setWeek}
            options={data.weeks.map((x) => x.week_start).reverse()}
            format={(s) => labels[s] + (data.weeks.find((x) => x.week_start === s)?.partial ? " (in progress)" : "")}
          />
        )}
      </CardHeader>
      <CardContent className="p-0">
        {w && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 px-6 pb-3 text-xs text-muted-foreground">
            <span><b className="text-foreground">{w.summary.full}</b> full</span>
            <span><b className="text-foreground">{w.summary.partial}</b> partial</span>
            <span><b className="text-foreground">{w.summary.not_scouted}</b> not scouted</span>
            <span>of {w.summary.houses} greenhouses</span>
          </div>
        )}
        {error && <div className="px-6 pb-4 text-xs text-[var(--sd-data-red)]">{error}</div>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Greenhouse</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Zones scouted</TableHead>
              <TableHead className="text-right">Beds scouted</TableHead>
              <TableHead className="text-right">Entries per bed</TableHead>
              <TableHead className="text-right">Entries</TableHead>
              <TableHead className="text-right">Under-scouted beds</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !data && <TableRowsSkeleton cols={8} rows={6} />}
            {rows.map((r) => (
              <Fragment key={r.house}>
                <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.house ? null : r.house)}>
                  <TableCell className="text-xs font-medium">{r.house}</TableCell>
                  <TableCell><StatusPill status={r.status} /></TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {r.zone_pct == null ? "—" : `${r.zone_pct}%`}
                    <span className="ml-1 text-muted-foreground">({r.zones_scouted}/{r.zones_total})</span>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{r.beds_scouted}/{r.beds_total}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{r.entries_per_bed ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{r.entries || "—"}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{r.beds_under ?? "—"}</TableCell>
                  <TableCell>
                    <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open === r.house && "rotate-180")} />
                  </TableCell>
                </TableRow>
                {open === r.house && (
                  <TableRow>
                    <TableCell colSpan={8} className="bg-muted/30"><Detail row={r} /></TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
            {!loading && !error && data && !rows.length && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                  No greenhouse with zones in this selection.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
