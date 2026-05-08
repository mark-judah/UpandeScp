import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, Plus, X, AlertTriangle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { LoadingStrip } from "@/components/LoadingStrip";
import { DatePicker } from "@/components/DatePicker";
import { UprightHeatmap } from "@/components/UprightHeatmap";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useScouting } from "@/hooks/use-scouting";
import {
  fetchApplicationPlanBootstrap,
  fetchBedsAndZones,
  fetchBomDetails,
  fetchZonesByGreenhouse,
  type BomDetails,
  type PlanBootstrap,
  type VarietyNode,
} from "@/lib/scouting-api";
import { call } from "@/lib/frappe";
import { ymd } from "@/lib/utils";
import type { ZoneGeo, ZoneObs } from "./maps/upright-svg";

const SPRAY_TYPES = [
  "Full",
  "Under",
  "Top",
  "Full + Top",
  "Full + Under",
  "Outside",
  "Drench",
] as const;

const SCOPES = ["Full Greenhouse", "Specific Variety", "Specific Bed(s)"] as const;

const COLOR_POOL = [
  "#E63946",
  "#E66BAA",
  "#E9A23B",
  "#8466C7",
  "#3D54B0",
  "#2BA6E0",
  "#5BB45D",
  "#10b981",
  "#f97316",
  "#a855f7",
];
const PEST_PALETTE: Record<string, string> = {};
function colorFor(name: string): string {
  if (!PEST_PALETTE[name]) {
    PEST_PALETTE[name] =
      COLOR_POOL[Object.keys(PEST_PALETTE).length % COLOR_POOL.length];
  }
  return PEST_PALETTE[name];
}

/** Wider window than 14 days so the "latest scouting" lookup catches real
 *  data even on greenhouses with sporadic visits. */
function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 60);
  return { from: ymd(from), to: ymd(today) };
}

function greenhouseOfZone(zoneName: string): string {
  const idx = zoneName.indexOf(" - Bed ");
  return idx >= 0 ? zoneName.slice(0, idx) : zoneName.split(" - ")[0];
}

interface DiagnoseFilters {
  pest: string;
  stage: string;
  section: string;
}

const ALL = "__all__";

export function ApplicationPlan() {
  const [bootstrap, setBootstrap] = useState<PlanBootstrap | null>(null);
  const [varietyTree, setVarietyTree] = useState<VarietyNode[]>([]);
  const [zonesByGh, setZonesByGh] = useState<Record<string, number>>({});
  const [greenhouse, setGreenhouse] = useState<string>("");

  const [diag, setDiag] = useState<DiagnoseFilters>({
    pest: ALL,
    stage: ALL,
    section: ALL,
  });

  // Spray details
  const [sprayDate, setSprayDate] = useState<string>(ymd(new Date()));
  const [sprayType, setSprayType] = useState<string>("");
  const [scope, setScope] = useState<string>("");
  const [bom, setBom] = useState<string>("");
  const [kit, setKit] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string>("");
  const [submitErr, setSubmitErr] = useState<string>("");

  // BOM details (chemicals + per-warehouse balances + selected source).
  const [bomDetails, setBomDetails] = useState<BomDetails | null>(null);
  const [bomLoading, setBomLoading] = useState(false);
  // chemical item_code → chosen source warehouse
  const [chemSource, setChemSource] = useState<Record<string, string>>({});

  // ── Background prefetch ───────────────────────────────────────────────
  // Mount kicks off scouting hydrate with crop=undefined so EVERY entry in
  // the 60-day window lands in IDB. Then when the user picks a greenhouse,
  // the filter is a cheap in-memory pass — no fresh API call, no spinner.
  // The "latest scouting" date works the same way: as soon as the bootstrap
  // arrives we already have entries to look at.
  const [{ from, to }] = useState(defaultRange);
  const { data, loading } = useScouting({
    from,
    to,
    crop: "Rose",
    // Intentionally not passing `greenhouse` — we filter client-side below,
    // which keeps the IDB warm for switching greenhouses without re-fetching.
  });

  useEffect(() => {
    fetchApplicationPlanBootstrap().then(setBootstrap);
    fetchBedsAndZones().then(setVarietyTree);
    fetchZonesByGreenhouse().then(setZonesByGh);
  }, []);

  // BOM detail fetch when selection changes.
  useEffect(() => {
    if (!bom) {
      setBomDetails(null);
      setChemSource({});
      return;
    }
    let cancelled = false;
    setBomLoading(true);
    fetchBomDetails(bom)
      .then((d) => {
        if (cancelled) return;
        setBomDetails(d);
        // Default each chemical's source to the first warehouse where it has stock.
        const next: Record<string, string> = {};
        d?.chemicals.forEach((c) => {
          const balances = c.balances || {};
          const first = Object.entries(balances).find(([, v]) => v > 0);
          if (first) next[c.item_code] = first[0];
          else if ((d.chemical_warehouses || []).length)
            next[c.item_code] = d.chemical_warehouses[0];
        });
        setChemSource(next);
      })
      .finally(() => !cancelled && setBomLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bom]);

  // Zones for the selected greenhouse.
  const zonesInGh: ZoneGeo[] = useMemo(() => {
    if (!greenhouse) return [];
    const out: ZoneGeo[] = [];
    for (const v of varietyTree) {
      for (const b of v.beds) {
        if (!b.name.startsWith(greenhouse)) continue;
        for (const z of b.zones) {
          out.push({ name: z.name, raw_geojson: z.raw_geojson });
        }
      }
    }
    return out;
  }, [varietyTree, greenhouse]);

  // Per-zone observation aggregate, filtered by Diagnose. Filters by
  // greenhouse here (instead of in useScouting) so the IDB stays universal.
  const zoneObs: Record<string, ZoneObs> = useMemo(() => {
    const out: Record<string, ZoneObs> = {};
    if (!data || !greenhouse) return out;
    for (const e of data.entries) {
      if (greenhouseOfZone(e.zone || "") !== greenhouse) continue;
      const apply = (name: string, section: string, stage: string) => {
        if (diag.pest !== ALL && name !== diag.pest) return;
        if (diag.section !== ALL && section !== diag.section) return;
        if (diag.stage !== ALL && stage !== diag.stage) return;
        const key = e.zone!;
        if (!out[key]) out[key] = { count: 0, color: colorFor(name) };
        out[key].count += 1;
      };
      e.pests_scouting_entry.forEach((p) =>
        apply(p.pest, p.plant_section || "", p.stage || ""),
      );
      e.diseases_scouting_entry.forEach((d) =>
        apply(d.disease, d.plant_section || "", d.stage || ""),
      );
    }
    return out;
  }, [data, greenhouse, diag]);

  // Latest scouting date for the selected greenhouse — picked from the
  // already-warmed IDB rather than a separate fetch.
  const latestScoutingDate = useMemo(() => {
    if (!data) return null;
    if (!greenhouse) {
      return data.entries[0]?.date_of_capture || null;
    }
    for (const e of data.entries) {
      if (greenhouseOfZone(e.zone || "") === greenhouse) {
        return e.date_of_capture;
      }
    }
    return null;
  }, [data, greenhouse]);

  const filterOpts = useMemo(() => {
    const pests = new Set<string>();
    const stages = new Set<string>();
    const sections = new Set<string>();
    if (data && greenhouse) {
      for (const e of data.entries) {
        if (greenhouseOfZone(e.zone || "") !== greenhouse) continue;
        e.pests_scouting_entry.forEach((p) => {
          pests.add(p.pest);
          if (p.stage) stages.add(p.stage);
          if (p.plant_section) sections.add(p.plant_section);
        });
        e.diseases_scouting_entry.forEach((d) => {
          pests.add(d.disease);
          if (d.stage) stages.add(d.stage);
          if (d.plant_section) sections.add(d.plant_section);
        });
      }
    }
    return {
      pests: Array.from(pests).sort(),
      stages: Array.from(stages).sort(),
      sections: Array.from(sections).sort(),
    };
  }, [data, greenhouse]);

  const totalZones = greenhouse ? zonesByGh[greenhouse] || 0 : 0;
  const affectedZones = Object.values(zoneObs).filter((o) => o.count > 0).length;
  const coveragePct = totalZones
    ? Math.round((affectedZones / totalZones) * 1000) / 10
    : 0;
  const recommendation =
    coveragePct >= 30
      ? "Heavy infestation — consider full greenhouse spray"
      : coveragePct >= 10
        ? "Moderate spread — spot-treat affected beds or spray full"
        : coveragePct > 0
          ? "Light pressure — spot-treat the flagged zones"
          : "No observations match this filter";

  const ghList = useMemo(
    () => bootstrap?.warehouses.map((w) => w.name).sort() || [],
    [bootstrap],
  );
  const bomList = useMemo(() => bootstrap?.boms || [], [bootstrap]);
  const kitList = useMemo(() => bootstrap?.kits || [], [bootstrap]);

  const submit = async () => {
    setSubmitMsg("");
    setSubmitErr("");
    if (!greenhouse || !sprayDate || !sprayType || !scope || !bom || !kit) {
      setSubmitErr("Fill in greenhouse, date, spray type, scope, kit and BOM.");
      return;
    }
    setBusy(true);
    try {
      const wh = kitList.find((k) => k.kit === kit)?.warehouse || undefined;
      const r: any = await call(
        "upande_scp.serverscripts.create_application_work_order.createApplicationWorkOrder",
        {
          greenhouse,
          scheduled_application_time: sprayDate,
          spray_type: sprayType,
          scope,
          kit,
          bom,
          source_warehouse: wh,
          chemical_sources: chemSource,
          targets:
            diag.pest !== ALL
              ? [{ target: diag.pest }]
              : Object.entries(zoneObs)
                  .filter(([, v]) => v.count > 0)
                  .map(([z]) => ({ zone: z })),
        },
      );
      setSubmitMsg(
        `Created ${r?.work_order || r?.message?.work_order || "work order"} — sent to Approvals.`,
      );
    } catch (e: any) {
      setSubmitErr(e?.message || "Submission failed");
    } finally {
      setBusy(false);
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
                New Application Floor Plan
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Diagnose · Prescribe · Submit for approval
              </p>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            <a href="/scp_app#/historical" className="underline">
              View past plans →
            </a>
          </div>
        </div>
      </header>

      {/* ── STEP 1 · DIAGNOSE ────────────────────────────────────── */}
      <section className="px-4 md:px-6 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-full bg-[var(--sd-accent)] text-white flex items-center justify-center text-xs font-semibold">
            1
          </div>
          <div>
            <div className="text-sm font-semibold">Diagnose</div>
            <div className="text-xs text-muted-foreground">
              Pick a greenhouse, review the heatmap, choose what to filter.
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1 min-w-56">
            <Label>Greenhouse</Label>
            <Select value={greenhouse || ""} onValueChange={setGreenhouse}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Pick a greenhouse" />
              </SelectTrigger>
              <SelectContent>
                {ghList.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Latest scouting</span>
            <span className="font-medium tabular-nums text-foreground">
              {loading && !latestScoutingDate
                ? "Loading…"
                : latestScoutingDate ||
                  (greenhouse
                    ? "No entries in 60 days"
                    : "Pick a greenhouse")}
            </span>
          </div>

          {greenhouse && (
            <div className="ml-auto text-xs text-muted-foreground tabular-nums">
              {affectedZones} / {totalZones} zones affected · {coveragePct}%
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[3fr_1fr] gap-3">
          <div>
            {greenhouse ? (
              <UprightHeatmap zones={zonesInGh} zoneObs={zoneObs} />
            ) : (
              <Card className="p-12 flex flex-col items-center justify-center text-center min-h-[420px]">
                <CardTitle className="text-sm">No greenhouse selected</CardTitle>
                <CardDescription className="mt-1">
                  {loading
                    ? "Loading scouting entries in the background…"
                    : "Pick a greenhouse to load the scouting heatmap."}
                </CardDescription>
              </Card>
            )}
          </div>

          <Card className="p-3">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Filters</CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label>Pest / Disease</Label>
                <Select
                  value={diag.pest}
                  onValueChange={(v) => setDiag({ ...diag, pest: v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All</SelectItem>
                    {filterOpts.pests.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Stage</Label>
                <Select
                  value={diag.stage}
                  onValueChange={(v) => setDiag({ ...diag, stage: v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All stages (cumulative)</SelectItem>
                    {filterOpts.stages.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Plant Section</Label>
                <Select
                  value={diag.section}
                  onValueChange={(v) => setDiag({ ...diag, section: v })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All sections</SelectItem>
                    {filterOpts.sections.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="rounded-md border bg-[var(--sd-bg-soft)] p-2.5">
                <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                  Chemical Requirements
                </div>
                <div className="text-xs text-foreground">{recommendation}</div>
                <div className="mt-2 h-2 rounded-full bg-[var(--sd-line)] overflow-hidden">
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.min(100, coveragePct)}%`,
                      background:
                        coveragePct >= 30
                          ? "var(--sd-data-red)"
                          : coveragePct >= 10
                            ? "var(--sd-target)"
                            : "var(--sd-data-green)",
                    }}
                  />
                </div>
                <div className="text-[0.65rem] text-muted-foreground mt-1 tabular-nums">
                  {coveragePct}% of zones flagged
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* ── STEP 2 · PRESCRIBE ───────────────────────────────────── */}
      <section className="px-4 md:px-6 py-4 border-t flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-full bg-[var(--sd-accent)] text-white flex items-center justify-center text-xs font-semibold">
            2
          </div>
          <div>
            <div className="text-sm font-semibold">Prescribe</div>
            <div className="text-xs text-muted-foreground">
              Set the application details and pick the BOM, then submit.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Card className="p-4">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Spray Details</CardTitle>
            </CardHeader>
            <CardContent className="p-0 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1 col-span-2">
                <Label>Scheduled Application Date</Label>
                <DatePicker value={sprayDate} onChange={setSprayDate} />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Spray Type</Label>
                <Select value={sprayType} onValueChange={setSprayType}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    {SPRAY_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <Label>Scope</Label>
                <Select value={scope} onValueChange={setScope}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Scope" />
                  </SelectTrigger>
                  <SelectContent>
                    {SCOPES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1 col-span-2">
                <Label>Kit</Label>
                <Select value={kit} onValueChange={setKit}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Pick a kit" />
                  </SelectTrigger>
                  <SelectContent>
                    {kitList.map((k) => (
                      <SelectItem key={k.kit} value={k.kit}>
                        {k.kit}
                        {k.warehouse ? ` · ${k.warehouse}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2">
                <Label>Targets</Label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {diag.pest !== ALL ? (
                    <Badge variant="default" className="text-[0.65rem]">
                      {diag.pest}
                    </Badge>
                  ) : Object.keys(zoneObs).length ? (
                    Array.from(
                      new Set(
                        data?.entries
                          .filter(
                            (e) =>
                              greenhouseOfZone(e.zone || "") === greenhouse &&
                              (e.zone ? !!zoneObs[e.zone] : false),
                          )
                          .flatMap((e) => [
                            ...e.pests_scouting_entry.map((p) => p.pest),
                            ...e.diseases_scouting_entry.map((d) => d.disease),
                          ]) || [],
                      ),
                    )
                      .slice(0, 12)
                      .map((t) => (
                        <Badge
                          key={t}
                          variant="outline"
                          className="text-[0.65rem]"
                        >
                          {t}
                        </Badge>
                      ))
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Pick a pest or filter the heatmap to define targets.
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="p-4">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Bill of Materials</CardTitle>
              <CardDescription>
                {bomList.length} active Chemical Mix BOMs
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 flex flex-col gap-3">
              <div className="flex items-end gap-2">
                <div className="flex-1 flex flex-col gap-1">
                  <Label>BOM</Label>
                  <Select value={bom} onValueChange={setBom}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select BOM" />
                    </SelectTrigger>
                    <SelectContent>
                      {bomList.map((b) => (
                        <SelectItem key={b.name} value={b.name}>
                          {b.item_name || b.name}
                          {b.custom_farm ? ` · ${b.custom_farm}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-9"
                  title="Open Desk to create a new BOM"
                >
                  <a
                    href="/app/bom/new?custom_item_group=Chemical+Mix"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New BOM
                  </a>
                </Button>
              </div>

              {bomLoading && (
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading chemicals…
                </div>
              )}

              {bomDetails && !bomLoading && (
                <>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <Stat
                      label="Mix size"
                      value={`${bomDetails.quantity || 0} ${bomDetails.uom || ""}`}
                    />
                    <Stat
                      label="Water pH"
                      value={bomDetails.custom_water_ph ?? "—"}
                    />
                    <Stat
                      label="Hardness"
                      value={bomDetails.custom_water_hardness ?? "—"}
                    />
                  </div>

                  <div>
                    <Label>Chemicals · pick source warehouse</Label>
                    {bomDetails.chemicals.length ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Chemical</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            <TableHead>Source</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {bomDetails.chemicals.map((c) => {
                            const balances = c.balances || {};
                            const isFert =
                              c.item_group ===
                              (bomDetails.fertilizer_warehouses?.length
                                ? "Fertilizer"
                                : "");
                            const whs = isFert
                              ? bomDetails.fertilizer_warehouses
                              : bomDetails.chemical_warehouses;
                            const picked = chemSource[c.item_code] || "";
                            return (
                              <TableRow key={c.item_code}>
                                <TableCell className="text-xs">
                                  <div className="font-medium">
                                    {c.item_name || c.item_code}
                                  </div>
                                  <div className="text-[0.65rem] text-muted-foreground font-mono">
                                    {c.item_code}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right tabular-nums text-xs">
                                  {c.stock_qty ?? "—"}
                                  {c.stock_uom ? ` ${c.stock_uom}` : ""}
                                </TableCell>
                                <TableCell>
                                  <Select
                                    value={picked}
                                    onValueChange={(v) =>
                                      setChemSource((prev) => ({
                                        ...prev,
                                        [c.item_code]: v,
                                      }))
                                    }
                                  >
                                    <SelectTrigger className="h-7 text-xs min-w-40">
                                      <SelectValue placeholder="Source" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {whs.map((w) => {
                                        const bal = balances[w] || 0;
                                        return (
                                          <SelectItem key={w} value={w}>
                                            <span className="truncate">
                                              {w}
                                            </span>{" "}
                                            <span className="text-muted-foreground tabular-nums">
                                              · {bal}
                                            </span>
                                          </SelectItem>
                                        );
                                      })}
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    ) : (
                      <div className="text-xs text-muted-foreground py-2">
                        BOM has no exploded items.
                      </div>
                    )}
                  </div>

                  <a
                    href={`/app/bom/${encodeURIComponent(bomDetails.name)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[0.7rem] text-muted-foreground underline inline-flex items-center gap-1"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open BOM in Desk
                  </a>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {(submitMsg || submitErr) && (
          <div
            className={`rounded-md border px-3 py-2 text-xs flex items-center gap-2 ${submitErr ? "border-[var(--sd-data-red)]/40 text-[var(--sd-data-red)] bg-[var(--sd-data-red)]/8" : "border-[var(--sd-data-green)]/40 text-[var(--sd-data-green)] bg-[var(--sd-data-green)]/8"}`}
          >
            {submitErr ? (
              <AlertTriangle className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {submitErr || submitMsg}
            <button
              type="button"
              onClick={() => {
                setSubmitMsg("");
                setSubmitErr("");
              }}
              className="ml-auto text-[0.7rem] underline"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={submit} disabled={busy || !greenhouse} size="lg">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create Spray Plan
          </Button>
        </div>
      </section>

      <LoadingStrip active={loading || busy || bomLoading} />
    </div>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="px-2 py-1.5 rounded bg-[var(--sd-bg-soft)] border">
      <div className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-xs font-medium tabular-nums">{value || "—"}</div>
    </div>
  );
}
