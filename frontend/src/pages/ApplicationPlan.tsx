import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Trash2, Maximize2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { LoadingStrip } from "@/components/LoadingStrip";
import { DatePicker } from "@/components/DatePicker";
import { UprightHeatmap } from "@/components/UprightHeatmap";
import { Toaster, type ToastItem } from "@/components/Toaster";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  searchChemicalItems,
  type BomChemical,
  type BomDetails,
  type ChemicalItem,
  type PlanBootstrap,
  type VarietyNode,
} from "@/lib/scouting-api";
import { call } from "@/lib/frappe";
import { ymd } from "@/lib/utils";
import {
  pestColor,
  diseaseColor,
  useObservationColors,
} from "@/lib/observation-colors";
import type { ZoneGeo, ZoneObs } from "./maps/upright-svg";
import { useView } from "@/lib/router";

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
const ALL = "__all__";

/**
 * Pick a canonical colour for an observation name. Tries pest first, then
 * disease — same name can never be both, so the second lookup is a cheap
 * fallback. Returns the neutral grey if neither knows it.
 */
function colorFor(name: string): string {
  const p = pestColor(name);
  if (p && p !== "#9ca3af") return p;
  return diseaseColor(name);
}

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

interface ChemRow extends BomChemical {
  /** Stable id so React doesn't re-mount unrelated rows when items change. */
  rowId: string;
  source?: string;
}

export function ApplicationPlan() {
  const [, navigate] = useView();
  const [bootstrap, setBootstrap] = useState<PlanBootstrap | null>(null);
  const [varietyTree, setVarietyTree] = useState<VarietyNode[]>([]);
  const [zonesByGh, setZonesByGh] = useState<Record<string, number>>({});
  const [greenhouse, setGreenhouse] = useState<string>("");
  const [diag, setDiag] = useState<DiagnoseFilters>({
    pest: ALL,
    stage: ALL,
    section: ALL,
  });
  // Subscribe to the live doctype colour map; we don't need its return
  // value because `colorFor` reads the module-level cache, but mounting
  // the hook here ensures the diagnose plot redraws after the fetch.
  useObservationColors();

  // Spray + BOM state
  const [sprayDate, setSprayDate] = useState<string>(ymd(new Date()));
  const [sprayType, setSprayType] = useState<string>("");
  const [scope, setScope] = useState<string>("");
  const [bom, setBom] = useState<string>("");
  const [kit, setKit] = useState<string>("");
  const [waterPh, setWaterPh] = useState<string>("");
  const [waterHardness, setWaterHardness] = useState<string>("");
  const [waterVolume, setWaterVolume] = useState<string>("");
  const [chemRows, setChemRows] = useState<ChemRow[]>([]);
  const [bomLoading, setBomLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bomDetails, setBomDetails] = useState<BomDetails | null>(null);

  // Add-chemical dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState<ChemicalItem[]>([]);
  const addTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Heatmap fullscreen modal
  const [heatmapModal, setHeatmapModal] = useState(false);

  // Inline toaster pinned just below the header.
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);
  const pushToast = (kind: ToastItem["kind"], text: string, autoMs = 4000) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, text }]);
    if (kind !== "loading" && autoMs > 0) {
      setTimeout(
        () => setToasts((prev) => prev.filter((t) => t.id !== id)),
        autoMs,
      );
    }
    return id;
  };
  const dismissToast = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  // Eager scouting prefetch (no greenhouse filter — IDB stays universal).
  const [{ from, to }] = useState(defaultRange);
  const { data, loading } = useScouting({ from, to, crop: "Rose" });

  useEffect(() => {
    fetchApplicationPlanBootstrap().then(setBootstrap);
    fetchBedsAndZones().then(setVarietyTree);
    fetchZonesByGreenhouse().then(setZonesByGh);
  }, []);

  // BOM details loader.
  useEffect(() => {
    if (!bom) {
      setBomDetails(null);
      setChemRows([]);
      setWaterPh("");
      setWaterHardness("");
      setWaterVolume("");
      return;
    }
    let cancelled = false;
    setBomLoading(true);
    fetchBomDetails(bom)
      .then((d) => {
        if (cancelled || !d) return;
        setBomDetails(d);
        setWaterPh(d.custom_water_ph?.toString() || "");
        setWaterHardness(d.custom_water_hardness?.toString() || "");
        setWaterVolume(d.custom_water_volume?.toString() || "");
        setChemRows(
          d.chemicals.map((c, i) => {
            const balances = c.balances || {};
            const first = Object.entries(balances).find(([, v]) => v > 0);
            const fallback = c.is_fertilizer
              ? d.fertilizer_warehouses
              : d.chemical_warehouses;
            return {
              ...c,
              rowId: `${c.item_code}-${i}`,
              source: first?.[0] || (fallback?.length ? fallback[0] : ""),
            };
          }),
        );
      })
      .finally(() => !cancelled && setBomLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bom]);

  // Add-chemical search debounce.
  useEffect(() => {
    if (!addOpen) return;
    if (addTimerRef.current) clearTimeout(addTimerRef.current);
    addTimerRef.current = setTimeout(() => {
      searchChemicalItems(addQuery).then(setAddResults);
    }, 200);
    return () => {
      if (addTimerRef.current) clearTimeout(addTimerRef.current);
    };
  }, [addQuery, addOpen]);

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

  const latestScoutingDate = useMemo(() => {
    if (!data) return null;
    if (!greenhouse) return data.entries[0]?.date_of_capture || null;
    for (const e of data.entries) {
      if (greenhouseOfZone(e.zone || "") === greenhouse) return e.date_of_capture;
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
    () => bootstrap?.warehouses.map((w) => w.name) || [],
    [bootstrap],
  );
  const bomList = useMemo(() => bootstrap?.boms || [], [bootstrap]);
  const kitList = useMemo(() => bootstrap?.kits || [], [bootstrap]);

  const updateChem = (rowId: string, patch: Partial<ChemRow>) =>
    setChemRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  const removeChem = (rowId: string) =>
    setChemRows((prev) => prev.filter((r) => r.rowId !== rowId));

  const addChemical = (item: ChemicalItem) => {
    const fallbackList = item.is_fertilizer
      ? bomDetails?.fertilizer_warehouses
      : bomDetails?.chemical_warehouses;
    setChemRows((prev) => [
      ...prev,
      {
        item_code: item.item_code,
        item_name: item.item_name,
        stock_uom: item.stock_uom,
        item_group: item.item_group,
        is_fertilizer: item.is_fertilizer,
        rowId: `${item.item_code}-${Date.now()}-${prev.length}`,
        source: fallbackList?.[0] || "",
        balances: {},
        stock_qty: 0,
      },
    ]);
    setAddOpen(false);
    setAddQuery("");
  };

  const submit = async () => {
    if (!greenhouse || !sprayDate || !sprayType || !scope || !bom || !kit) {
      pushToast("err", "Fill in greenhouse, date, spray type, scope, kit and BOM.");
      return;
    }
    if (!chemRows.length) {
      pushToast("err", "Add at least one chemical.");
      return;
    }
    for (const c of chemRows) {
      if (!c.item_code || !c.stock_uom || !c.source) {
        pushToast(
          "err",
          "Every chemical needs an item, UoM and source warehouse.",
        );
        return;
      }
      if (!c.stock_qty || c.stock_qty <= 0) {
        pushToast("err", `Set a quantity > 0 for ${c.item_name || c.item_code}.`);
        return;
      }
    }
    if (!waterPh || !waterHardness) {
      pushToast("err", "Water pH and hardness are required.");
      return;
    }

    const loaderId = pushToast("loading", "Submitting spray plan…", 0);
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
          water_ph: Number(waterPh),
          water_hardness: Number(waterHardness),
          water_volume: waterVolume ? Number(waterVolume) : undefined,
          chemicals: chemRows.map((c) => ({
            chemical: c.item_name || c.item_code,
            item_code: c.item_code,
            uom: c.stock_uom,
            application_rate: c.stock_qty,
            source_warehouse: c.source,
          })),
          targets:
            diag.pest !== ALL
              ? [{ target: diag.pest }]
              : Object.entries(zoneObs)
                  .filter(([, v]) => v.count > 0)
                  .map(([z]) => ({ zone: z })),
        },
      );
      dismissToast(loaderId);
      pushToast(
        "ok",
        `Created ${r?.work_order || r?.message?.work_order || "work order"} — redirecting to Approvals…`,
      );
      setTimeout(() => navigate("approvals"), 800);
    } catch (e: any) {
      dismissToast(loaderId);
      pushToast("err", e?.message || "Submission failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-40 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
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
          <a
            href="/scp_app#/historical"
            className="text-xs text-muted-foreground underline"
          >
            View past plans →
          </a>
        </div>
      </header>

      <Toaster items={toasts} onDismiss={dismissToast} />

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
                  (greenhouse ? "No entries in 60 days" : "—")}
            </span>
          </div>
          {greenhouse && (
            <div className="ml-auto text-xs text-muted-foreground tabular-nums">
              {affectedZones} / {totalZones} zones · {coveragePct}%
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="relative">
            {greenhouse && zonesInGh.length ? (
              <button
                type="button"
                onClick={() => setHeatmapModal(true)}
                className="block w-full text-left"
                title="Click for full-screen view"
              >
                <UprightHeatmap
                  zones={zonesInGh}
                  zoneObs={zoneObs}
                  className="hover:ring-2 hover:ring-[var(--sd-accent)]/30 transition-shadow"
                />
                <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-card/90 backdrop-blur border px-2 py-1 text-[0.65rem] text-muted-foreground">
                  <Maximize2 className="h-3 w-3" />
                  Click for full view
                </span>
              </button>
            ) : (
              <Card className="p-8 flex flex-col items-center justify-center text-center min-h-[320px]">
                <CardTitle className="text-sm">
                  {greenhouse ? "Loading geometry…" : "No greenhouse selected"}
                </CardTitle>
                <CardDescription className="mt-1">
                  {greenhouse
                    ? "Zone polygons are being parsed in the background."
                    : loading
                      ? "Loading scouting entries in the background…"
                      : "Pick a greenhouse to load the scouting heatmap."}
                </CardDescription>
              </Card>
            )}
          </div>

          <Card className="p-3">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">Filters</CardTitle>
              <CardDescription>
                Same controls as the legacy spray-plan page · pest / stage / section.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1 col-span-2">
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

              <div className="col-span-2 rounded-md border bg-[var(--sd-bg-soft)] p-2.5">
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
              </div>

              {bomLoading && (
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading chemicals…
                </div>
              )}

              {bomDetails && !bomLoading && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <NumInput label="Water pH" value={waterPh} onChange={setWaterPh} />
                    <NumInput
                      label="Hardness"
                      value={waterHardness}
                      onChange={setWaterHardness}
                    />
                    <NumInput
                      label="Volume L/Ha"
                      value={waterVolume}
                      onChange={setWaterVolume}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label>Chemicals · pick source warehouse</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[0.7rem]"
                        onClick={() => setAddOpen(true)}
                      >
                        <Plus className="h-3 w-3" />
                        Add chemical
                      </Button>
                    </div>
                    {chemRows.length ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Chemical</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            <TableHead>Source</TableHead>
                            <TableHead className="w-8" />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {chemRows.map((c) => {
                            const balances = c.balances || {};
                            const whs = c.is_fertilizer
                              ? bomDetails.fertilizer_warehouses
                              : bomDetails.chemical_warehouses;
                            return (
                              <TableRow key={c.rowId}>
                                <TableCell className="text-xs">
                                  <div className="font-medium">
                                    {c.item_name || c.item_code}
                                  </div>
                                  <div className="text-[0.65rem] text-muted-foreground font-mono">
                                    {c.item_code}
                                    {c.is_fertilizer ? (
                                      <span className="ml-1 text-[var(--sd-data-green)]">
                                        · Fertilizer Store
                                      </span>
                                    ) : (
                                      <span className="ml-1 text-[var(--sd-data-cyan)]">
                                        · Chemical Store
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  <Input
                                    value={c.stock_qty?.toString() || ""}
                                    onChange={(e) =>
                                      updateChem(c.rowId, {
                                        stock_qty: Number(e.target.value),
                                      })
                                    }
                                    type="number"
                                    step="any"
                                    min={0}
                                    className="h-7 text-xs text-right tabular-nums w-20 ml-auto"
                                  />
                                  <div className="text-[0.65rem] text-muted-foreground mt-0.5">
                                    {c.stock_uom || ""}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Select
                                    value={c.source || ""}
                                    onValueChange={(v) =>
                                      updateChem(c.rowId, { source: v })
                                    }
                                  >
                                    <SelectTrigger className="h-7 text-xs min-w-44">
                                      <SelectValue placeholder="Source" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {whs.map((w) => {
                                        const bal = balances[w] || 0;
                                        return (
                                          <SelectItem key={w} value={w}>
                                            <span className="truncate">{w}</span>{" "}
                                            <span className="text-muted-foreground tabular-nums">
                                              · {bal}
                                            </span>
                                          </SelectItem>
                                        );
                                      })}
                                    </SelectContent>
                                  </Select>
                                </TableCell>
                                <TableCell>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 text-muted-foreground"
                                    onClick={() => removeChem(c.rowId)}
                                    title="Remove"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    ) : (
                      <div className="text-xs text-muted-foreground py-2">
                        BOM has no exploded items. Add one with the button above.
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="flex justify-end">
          <Button onClick={submit} disabled={busy || !greenhouse} size="lg">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Create Spray Plan
          </Button>
        </div>
      </section>

      {/* Fullscreen heatmap modal */}
      <Dialog open={heatmapModal} onOpenChange={setHeatmapModal}>
        <DialogContent className="max-w-6xl">
          <DialogHeader>
            <DialogTitle>{greenhouse}</DialogTitle>
            <DialogDescription>
              {affectedZones} of {totalZones} zones · {coveragePct}% coverage
            </DialogDescription>
          </DialogHeader>
          <UprightHeatmap zones={zonesInGh} zoneObs={zoneObs} />
        </DialogContent>
      </Dialog>

      {/* Add-chemical popup */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add chemical</DialogTitle>
            <DialogDescription>
              Search by item name. Restricted to chemical and fertilizer item
              groups so the source-warehouse picker stays valid.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={addQuery}
            onChange={(e) => setAddQuery(e.target.value)}
            placeholder="Search…"
            autoFocus
          />
          <div className="max-h-72 overflow-auto flex flex-col gap-1">
            {addResults.map((it) => (
              <button
                key={it.item_code}
                type="button"
                onClick={() => addChemical(it)}
                className="text-left px-3 py-2 rounded-md border bg-card hover:bg-muted transition-colors"
              >
                <div className="text-xs font-medium">
                  {it.item_name || it.item_code}
                </div>
                <div className="text-[0.65rem] text-muted-foreground font-mono">
                  {it.item_code} · {it.stock_uom || ""}
                  {it.is_fertilizer ? (
                    <span className="ml-1 text-[var(--sd-data-green)]">
                      · Fertilizer Store
                    </span>
                  ) : (
                    <span className="ml-1 text-[var(--sd-data-cyan)]">
                      · Chemical Store
                    </span>
                  )}
                </div>
              </button>
            ))}
            {!addResults.length && (
              <div className="text-xs text-muted-foreground py-3 text-center">
                Type to search.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <LoadingStrip active={loading || busy || bomLoading} />
    </div>
  );
}

function NumInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[0.65rem]">{label}</Label>
      <Input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs tabular-nums"
      />
    </div>
  );
}
