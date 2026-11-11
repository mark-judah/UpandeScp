/**
 * Crop Protection ▸ Biologicals — predators released into greenhouses (by spray
 * supervisors, from the store) and what the sprays since are EXPECTED to have
 * killed. Roses for now.
 *
 * "Expected" is released quantity x the spray's ingredient mortality for that
 * predator (an IOBC class estimate): never a count of dead animals, and labelled so.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { FilterSelect } from "@/components/FilterSelect";
import { DateRangePicker } from "@/components/DateRangePicker";
import { PageHeader } from "@/components/PageHeader";
import { LoadProgress, TableRowsSkeleton } from "@/components/Loading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  fetchMortality, fetchReleases, qty, whenLabel,
  type MortalityPayload, type ReleasesPayload,
} from "@/lib/biologicals-api";
import { errorText } from "@/lib/errors";
import { ymd } from "@/lib/utils";

type TabKey = "releases" | "mortality";

function lastNinetyDays() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 90);
  return { from: ymd(from), to: ymd(to) };
}

export function Biologicals({ initialCrop: _crop }: { initialCrop?: string } = {}) {
  const [tab, setTab] = useState<TabKey>("releases");
  const [{ from, to }, setRange] = useState(lastNinetyDays);
  const [greenhouse, setGreenhouse] = useState("");
  const [predator, setPredator] = useState("");
  const [releases, setReleases] = useState<ReleasesPayload | null>(null);
  const [mortality, setMortality] = useState<MortalityPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const base = { from_date: from, to_date: to, greenhouse: greenhouse || undefined };
      const [r, m] = await Promise.all([
        fetchReleases({ ...base, predator: predator || undefined }),
        fetchMortality(base),
      ]);
      setReleases(r);
      setMortality(m);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [from, to, greenhouse, predator]);

  useEffect(() => {
    void load();
  }, [load]);

  const houses = useMemo(
    () => [...new Set([...(releases?.filters.greenhouses ?? []), ...(greenhouse ? [greenhouse] : [])])].sort(),
    [releases, greenhouse],
  );
  const first = loading && !releases;

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader
        eyebrow="Crop Protection · Roses"
        title="Biologicals"
        tab={tab}
        switcher={
          <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
            <TabsList>
              <TabsTrigger value="releases">Releases</TabsTrigger>
              <TabsTrigger value="mortality">Expected mortality</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      >
        <FilterSelect label="Greenhouse" value={greenhouse} onChange={setGreenhouse} options={houses} allLabel="All greenhouses" />
        {tab === "releases" ? (
          <FilterSelect label="Predator" value={predator} onChange={setPredator}
            options={releases?.filters.predators ?? []} allLabel="All predators" />
        ) : null}
        <DateRangePicker label="Date range" value={{ from, to }} onChange={setRange} />
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress active={loading} progress={null} />
        {error ? <div className="text-xs text-[var(--sd-data-red)]">Failed to load: {error}</div> : null}

        {tab === "releases" ? (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">By predator</CardTitle>
                  <CardDescription>Units issued from the store in the period.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {(releases?.by_predator ?? []).map((p) => (
                    <span key={`${p.predator}-${p.uom}`}>
                      <span className="font-medium">{p.predator}</span> {qty(p.quantity)} {p.uom}
                    </span>
                  ))}
                  {releases && !releases.by_predator.length ? <span className="text-muted-foreground">No releases in this period.</span> : null}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">By greenhouse</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {(releases?.by_greenhouse ?? []).map((g) => (
                    <span key={g.greenhouse}><span className="font-medium">{g.greenhouse}</span> {qty(g.quantity)}</span>
                  ))}
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead><TableHead>Greenhouse</TableHead><TableHead>Predator</TableHead>
                      <TableHead>Stage</TableHead><TableHead className="text-right">Quantity</TableHead>
                      <TableHead>Released by</TableHead><TableHead>Store</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {first ? <TableRowsSkeleton cols={7} /> : (releases?.rows ?? []).map((r) => (
                      <TableRow key={r.name}>
                        <TableCell>{whenLabel(r.released_at)}</TableCell>
                        <TableCell>{r.greenhouse}</TableCell>
                        <TableCell className="font-medium">{r.predator}</TableCell>
                        <TableCell>{r.stage || "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{qty(r.quantity)} {r.uom}</TableCell>
                        <TableCell>{r.released_by_name || "—"}</TableCell>
                        <TableCell>{r.store || "—"}</TableCell>
                      </TableRow>
                    ))}
                    {releases && !releases.rows.length ? (
                      <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">No releases in this period.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="mortality-label">
              {mortality?.label ?? "Expected mortality: released quantity x ingredient mortality (IOBC class estimate)."}
              {mortality ? ` Predators count as present for ${mortality.presence_days} days after a release.` : ""}
            </p>
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-xs">
              <span>Total expected kill <b className="tabular-nums">{qty(mortality?.total ?? 0)}</b></span>
              {Object.entries(mortality?.by_predator ?? {}).map(([p, v]) => (
                <span key={p}>{p} <b className="tabular-nums">{qty(v)}</b></span>
              ))}
              {Object.entries(mortality?.by_greenhouse ?? {}).map(([g, v]) => (
                <span key={g} className="text-muted-foreground">{g} <b className="tabular-nums text-foreground">{qty(v)}</b></span>
              ))}
            </div>
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Spray</TableHead><TableHead>Greenhouse</TableHead><TableHead>Predator</TableHead>
                      <TableHead className="text-right">Present</TableHead><TableHead className="text-right">Mortality</TableHead>
                      <TableHead className="text-right">Expected kill</TableHead><TableHead>Mix</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {first ? <TableRowsSkeleton cols={7} /> : (mortality?.rows ?? []).map((r) => (
                      <TableRow key={`${r.wo}-${r.predator}`}>
                        <TableCell>{whenLabel(r.when)}</TableCell>
                        <TableCell>{r.greenhouse}</TableCell>
                        <TableCell className="font-medium">{r.predator}</TableCell>
                        <TableCell className="text-right tabular-nums">{qty(r.present)} {r.uom}</TableCell>
                        <TableCell className="text-right tabular-nums">{qty(r.mortality_pct)}%</TableCell>
                        <TableCell className="text-right tabular-nums">{qty(r.expected_kill)} {r.uom}</TableCell>
                        <TableCell className="max-w-[24rem] truncate">{r.products.join(", ")}</TableCell>
                      </TableRow>
                    ))}
                    {mortality && !mortality.rows.length ? (
                      <TableRow><TableCell colSpan={7} className="py-6 text-center text-muted-foreground">No completed spray met released predators in this period.</TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default Biologicals;
