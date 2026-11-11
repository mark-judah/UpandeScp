/**
 * Personnel ▸ Supervisors — how each spray supervisor did over a date range,
 * ranked. A plan counts for every supervisor on its team and ends in one of four
 * outcomes: on time (spraying started within two hours of the planned time),
 * late (the same day), missed (a later day) or never started. "Scanned or
 * started by them" separates the plan's supervisor from whoever actually ran it.
 * Read-only.
 */
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { PlacePicker } from "@/components/PlacePicker";
import { DateRangePicker } from "@/components/DateRangePicker";
import { LoadProgress, TableRowsSkeleton } from "@/components/Loading";
import { Figure, FigureRow } from "@/components/people/Figure";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { fetchSupervisors, type SupervisorsPayload } from "@/lib/supervisors-api";
import { errorText } from "@/lib/errors";
import { lastFourWeeks } from "@/pages/Scouts";

const pct = (v: number | null) => (v == null ? "—" : `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`);
const num = (v: number) => (v ? String(v) : "—");

export function Supervisors({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const [farm, setFarm] = useState("");
  const [{ from, to }, setRange] = useState(() => lastFourWeeks());
  const [data, setData] = useState<SupervisorsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetchSupervisors({ crop, farm, from_date: from, to_date: to })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(errorText(e, "Could not load the supervisors.")))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [crop, farm, from, to]);

  const rows = data?.rows ?? [];
  const sum = (k: "due" | "on_time" | "late" | "missed" | "never_started") =>
    rows.reduce((n, r) => n + r[k], 0);
  const onTime = sum("due") ? Math.round((1000 * sum("on_time")) / sum("due")) / 10 : null;

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Personnel · Spraying" title="Supervisors">
        <PlacePicker
          level="farm"
          farms={data?.farms || []}
          crop={crop}
          label="Supervisors farm"
          value={{ farm, greenhouse: "" }}
          onChange={(p) => setFarm(p.farm || "")}
          disabled={!data}
        />
        <DateRangePicker label="Supervisors date range" value={{ from, to }} onChange={setRange} />
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress active={loading && !!data} progress={null} className="self-end" />
        {error && <div className="text-xs text-[var(--sd-data-red)]">{error}</div>}

        <FigureRow>
          <Figure label="Plans" value={data ? String(data.plans) : "—"} hint="scheduled in the range" />
          <Figure label="On time" value={pct(onTime)} hint={`started within ${data?.grace_hours ?? 2} h`} />
          <Figure label="Late" value={String(sum("late"))} hint="same day" />
          <Figure label="Missed / never started" value={`${sum("missed")} / ${sum("never_started")}`} hint="later day / not at all" />
        </FigureRow>
        {data && data.no_supervisor > 0 && (
          <p className="text-xs text-[var(--sd-muted)]">
            {data.no_supervisor} plan{data.no_supervisor === 1 ? " has" : "s have"} no supervisor on the team, so
            they count for nobody here.
          </p>
        )}

        <Card className="p-0">
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Supervisor</TableHead>
                  <TableHead className="text-right">Plans</TableHead>
                  <TableHead className="text-right">Scanned by them</TableHead>
                  <TableHead className="text-right">By someone else</TableHead>
                  <TableHead className="text-right">Nobody scanned</TableHead>
                  <TableHead className="text-right">Completed</TableHead>
                  <TableHead className="text-right">On time</TableHead>
                  <TableHead className="text-right">Late</TableHead>
                  <TableHead className="text-right">Missed</TableHead>
                  <TableHead className="text-right">Never started</TableHead>
                  <TableHead className="text-right">On-time %</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && !data && <TableRowsSkeleton cols={12} rows={6} />}
                {rows.map((r) => (
                  <TableRow key={r.employee}>
                    <TableCell className="tabular-nums text-xs">{r.rank ?? "—"}</TableCell>
                    <TableCell className="text-xs font-medium">
                      {r.name}
                      {r.covered_for_others > 0 && (
                        <span className="ml-2 text-[0.65rem] font-normal text-[var(--sd-muted)]">
                          also ran {r.covered_for_others} plan{r.covered_for_others === 1 ? "" : "s"} of others
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{r.assigned}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{num(r.acted)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{num(r.by_other)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{num(r.nobody)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{num(r.completed)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{num(r.on_time)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{num(r.late)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-[var(--sd-data-red)]">{num(r.missed)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs text-[var(--sd-data-red)]">{num(r.never_started)}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs font-semibold">{pct(r.on_time_pct)}</TableCell>
                  </TableRow>
                ))}
                {!loading && !rows.length && !error && (
                  <TableRow>
                    <TableCell colSpan={12} className="py-10 text-center text-sm text-muted-foreground">
                      No supervisor has a spray plan in this range.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-[0.7rem] text-[var(--sd-muted)]">
          A plan counts for every supervisor on its team. On time = spraying started no later than two hours after the
          planned time; late = later the same day; missed = on a later day; never started = not at all and its day has
          passed. Plans still ahead and stopped plans are not counted. Ranked by on-time share.
        </p>
      </div>
    </div>
  );
}
