import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, Trash2, Maximize2, FilePlus2 } from "lucide-react";
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
import { DatePicker } from "@/components/DatePicker";
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
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { MarkerDefs } from "./maps/MarkerDefs";
import { BedSvg, type BedMarker } from "./maps/BedSvg";
import {
  projectGeometry,
  type ProjectedGeometry,
  type ZoneGeoLike,
} from "./maps/bed-projection";
import {
  createBom,
  fetchBedsAndZones,
  fetchBedsByGreenhouse,
  fetchBomDetails,
  fetchZonesByGreenhouse,
  searchChemicalItems,
  type BedAreaRow,
  type BomChemical,
  type BomDetails,
  type ChemicalItem,
  type RateLimit,
  type VarietyNode,
} from "@/lib/scouting-api";
import {
  createDraftSprayPlan,
  fetchCreatorBootstrap,
  type CreatorBootstrap,
} from "@/lib/spray-plan-creator-api";
import { FrappeError } from "@/lib/frappe";
import { ymd } from "@/lib/utils";
import {
  pestColor,
  diseaseColor,
  useObservationColors,
} from "@/lib/observation-colors";
interface ZoneObs {
  count: number;
  color: string;
  kind?: "pest" | "disease";
}

interface DiagnosePayload {
  zoneObs: Record<string, ZoneObs>;
  latestDate: string | null;
  filterOpts: { pests: string[]; sections: string[]; stages: string[] };
  totalRows: number;
  targets: string[];
}

/** Litres of water per hectare — same constant the legacy
 *  ``new_application_floor_plan.js`` uses to derive ``custom_water_volume``
 *  from the area-to-spray. Exported as a named constant so the UI
 *  caption stays in sync if it ever needs tweaking. */
const WATER_VOLUME_RATE = 1000;

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

/**
 * Parse the legacy "Specific Bed(s)" mini-language into a Set of bed
 * numbers as strings. Accepts comma-separated single numbers and
 * inclusive ranges (e.g. ``"1-5, 7, 9"`` → ``{"1","2","3","4","5","7","9"}``).
 * Whitespace around tokens and around the hyphen is tolerated; anything
 * that doesn't parse as a number or range is silently ignored — same
 * permissive semantics as the legacy ``calculateAreaToSpray`` parser.
 */
function parseBedRanges(input: string): Set<string> {
  const out = new Set<string>();
  if (!input) return out;
  for (const seg of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = seg.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
        for (let i = start; i <= end; i++) out.add(String(i));
      }
      continue;
    }
    const single = seg.match(/^(\d+)$/);
    if (single) out.add(single[1]);
  }
  return out;
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

/** Return a human message when ``qty`` falls outside the limits for
 *  ``itemCode``, or ``null`` when it's in range / no limits are configured.
 *  Pure so the same function can drive both the inline warning under the
 *  rate input and the pre-submit guard. */
function rateLimitError(
  itemCode: string | undefined,
  qty: number | undefined,
  limits: Record<string, RateLimit>,
): string | null {
  if (!itemCode || !qty || qty <= 0) return null;
  const lim = limits[itemCode];
  if (!lim) return null;
  if (lim.lower != null && qty < lim.lower) {
    return `Below lower limit of ${lim.lower} per 1000L.`;
  }
  if (lim.upper != null && qty > lim.upper) {
    return `Above upper limit of ${lim.upper} per 1000L.`;
  }
  return null;
}

export function ApplicationPlan() {
  const [bootstrap, setBootstrap] = useState<CreatorBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<{ status: number; message: string } | null>(null);
  const [varietyTree, setVarietyTree] = useState<VarietyNode[]>([]);
  const [bedsByGh, setBedsByGh] = useState<Record<string, BedAreaRow[]>>({});
  const [zonesByGh, setZonesByGh] = useState<Record<string, number>>({});
  // Per-chemical application-rate bounds (Item.custom_lower/upper_rate_limit).
  // Empty by default; populated once at mount so the rate inputs can flag
  // out-of-range values inline as the operator types.
  const [rateLimits, setRateLimits] = useState<Record<string, RateLimit>>({});
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
  const [classification, setClassification] = useState<"" | "Curative" | "Preventive">("");
  const [preventiveReason, setPreventiveReason] = useState<string>("");
  const [waterPh, setWaterPh] = useState<string>("");
  const [waterHardness, setWaterHardness] = useState<string>("");
  const [waterVolume, setWaterVolume] = useState<string>("");
  const [chemRows, setChemRows] = useState<ChemRow[]>([]);
  const [bomLoading, setBomLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bomDetails, setBomDetails] = useState<BomDetails | null>(null);

  // Scope-driven extras (legacy parity).
  // ``selectedVarieties`` populates the WO's ``custom_variety``
  // (comma-separated) when scope === "Specific Variety".
  // ``bedNumbers`` populates ``custom_scope_details`` when scope is
  // "Specific Bed(s)" — same free-text format as the legacy page (e.g.
  // "1-5, 7, 9").
  const [selectedVarieties, setSelectedVarieties] = useState<Set<string>>(
    new Set(),
  );
  const [bedNumbers, setBedNumbers] = useState<string>("");
  const [area, setArea] = useState<string>("");
  const [sprayTeam, setSprayTeam] = useState<string>("");
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  // Add-chemical dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState<ChemicalItem[]>([]);
  const addTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // BOM creation dialog
  const [bomDialogOpen, setBomDialogOpen] = useState(false);
  const [newBomItem, setNewBomItem] = useState<string>("");
  const [newBomPh, setNewBomPh] = useState<string>("7");
  const [newBomHardness, setNewBomHardness] = useState<string>("100");
  const [newBomChems, setNewBomChems] = useState<ChemicalItem[]>([]);
  const [newBomSearch, setNewBomSearch] = useState<string>("");
  const [newBomSearchResults, setNewBomSearchResults] = useState<ChemicalItem[]>(
    [],
  );
  const [creatingBom, setCreatingBom] = useState(false);
  const newBomSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

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

  // Diagnose-step data: per-zone counts + filter options for the currently
  // selected greenhouse. One server endpoint replaces the old
  // useScouting-pulls-everything pattern.
  const [{ from, to }] = useState(defaultRange);
  const diagnoseFilters = useMemo(
    () => ({
      greenhouse,
      from_date: from,
      to_date:   to,
      crop:      "Rose",
      pest:      diag.pest === ALL ? "" : diag.pest,
      section:   diag.section === ALL ? "" : diag.section,
      stage:     diag.stage === ALL ? "" : diag.stage,
    }),
    [greenhouse, from, to, diag],
  );
  const diagnoseState = useDashboardAggregate<DiagnosePayload>(
    "application_plan_diagnose",
    diagnoseFilters as any,
    !!greenhouse,
  );
  const diagnose = diagnoseState.data;
  const loading = diagnoseState.loading;

  useEffect(() => {
    let cancelled = false;
    fetchCreatorBootstrap()
      .then((b) => {
        if (cancelled) return;
        setBootstrap(b);
        setRateLimits(b.rate_limits as Record<string, RateLimit>);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof FrappeError) {
          setBootstrapError({ status: e.status, message: e.message });
        } else {
          setBootstrapError({ status: 0, message: String(e) });
        }
      });
    fetchBedsAndZones().then((v) => !cancelled && setVarietyTree(v));
    fetchZonesByGreenhouse().then((z) => !cancelled && setZonesByGh(z));
    fetchBedsByGreenhouse().then((b) => !cancelled && setBedsByGh(b));
    return () => {
      cancelled = true;
    };
  }, []);

  // BOM details loader. Note: waterVolume is owned by the area-calc
  // effect below — we deliberately don't seed it here so the BOM
  // loader (which runs whenever ``bom`` changes) can't race with the
  // scope-driven auto-calc and clobber a freshly computed value.
  useEffect(() => {
    if (!bom) {
      setBomDetails(null);
      setChemRows([]);
      setWaterPh("");
      setWaterHardness("");
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

  // BOM-creation chemical search debounce.
  useEffect(() => {
    if (!bomDialogOpen) return;
    if (newBomSearchTimerRef.current)
      clearTimeout(newBomSearchTimerRef.current);
    newBomSearchTimerRef.current = setTimeout(() => {
      searchChemicalItems(newBomSearch).then(setNewBomSearchResults);
    }, 200);
    return () => {
      if (newBomSearchTimerRef.current)
        clearTimeout(newBomSearchTimerRef.current);
    };
  }, [newBomSearch, bomDialogOpen]);

  // Reset scope-detail extras when the scope or greenhouse changes.
  useEffect(() => {
    setSelectedVarieties(new Set());
    setBedNumbers("");
  }, [scope, greenhouse]);

  useEffect(() => {
    setSelectedTargets(new Set());
  }, [greenhouse, classification]);

  // Varieties present in the picked greenhouse (legacy "Specific Variety"
  // multi-select source).
  const varietiesInGh: string[] = useMemo(() => {
    if (!greenhouse) return [];
    const out = new Set<string>();
    for (const v of varietyTree) {
      for (const b of v.beds) {
        if (b.name.startsWith(greenhouse)) {
          out.add(v.variety);
          break;
        }
      }
    }
    return Array.from(out).sort();
  }, [varietyTree, greenhouse]);

  /**
   * Auto-calculated area-to-spray (Ha) and water volume (L). Direct port
   * of the legacy ``calculateAreaToSpray`` function — sums per-bed
   * ``bed__area`` (sq m) according to the scope, divides by 10000 for
   * hectares, then multiplies by ``WATER_VOLUME_RATE`` for litres of
   * water at the standard 1000 L/Ha spray rate.
   *
   * "Specific Variety" sums each selected variety's bed-areas in this
   * greenhouse once (mirroring the ``accountedVarieties`` guard in the
   * legacy code so each variety isn't counted multiple times when it
   * spans many beds).
   *
   * "Specific Bed(s)" parses the same "1-5, 7, 9" mini-language the
   * legacy page accepts.
   */
  const { areaHa, waterVolumeL } = useMemo(() => {
    if (!greenhouse || !scope) return { areaHa: 0, waterVolumeL: 0 };
    const beds = bedsByGh[greenhouse] || [];
    let sqm = 0;
    if (scope === "Full Greenhouse") {
      sqm = beds.reduce((s, b) => s + (b.bed__area || 0), 0);
    } else if (scope === "Specific Variety") {
      const accounted = new Set<string>();
      for (const b of beds) {
        if (
          b.variety &&
          selectedVarieties.has(b.variety) &&
          !accounted.has(b.variety)
        ) {
          // Sum the variety's full footprint in this greenhouse on first
          // encounter, then mark it accounted so a multi-bed variety
          // doesn't double-count.
          const total = beds
            .filter((x) => x.variety === b.variety)
            .reduce((s, x) => s + (x.bed__area || 0), 0);
          sqm += total;
          accounted.add(b.variety);
        }
      }
    } else if (scope === "Specific Bed(s)") {
      const wanted = parseBedRanges(bedNumbers);
      if (wanted.size) {
        for (const b of beds) {
          if (b.bed && wanted.has(String(b.bed))) sqm += b.bed__area || 0;
        }
      }
    }
    const ha = sqm > 0 ? sqm / 10000 : 0;
    return {
      areaHa: ha,
      waterVolumeL: ha > 0 ? ha * WATER_VOLUME_RATE : 0,
    };
  }, [greenhouse, scope, bedsByGh, selectedVarieties, bedNumbers]);

  // Push the derived numbers into the area + water-volume inputs.
  // Single source of truth — the BOM loader does NOT seed waterVolume
  // anymore so this effect can't be raced. Priority order:
  //   1. derived scope-based value if scope is set and bed areas resolve
  //   2. BOM's ``custom_water_volume`` as a fallback when there's no
  //      derivable area yet (e.g. user picked the BOM but not the scope)
  //   3. empty string otherwise
  useEffect(() => {
    if (scope && areaHa > 0) {
      setArea(areaHa.toFixed(4));
      setWaterVolume(waterVolumeL.toFixed(2));
      return;
    }
    if (scope) {
      // Scope is set but no bed areas resolved yet (still loading, or
      // greenhouse has no Bed records) — keep the field empty so the
      // user knows the calc didn't find anything.
      setArea("");
      setWaterVolume("");
      return;
    }
    if (bomDetails?.custom_water_volume) {
      setWaterVolume(String(bomDetails.custom_water_volume));
    } else {
      setWaterVolume("");
    }
    setArea("");
  }, [scope, areaHa, waterVolumeL, bomDetails]);

  const zonesInGh: ZoneGeoLike[] = useMemo(() => {
    if (!greenhouse) return [];
    const out: ZoneGeoLike[] = [];
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

  // Equirectangular projection for the selected greenhouse. Memoised on
  // the zonesInGh reference so flipping diagnose filters doesn't redo
  // the math.
  const geometry: ProjectedGeometry | null = useMemo(
    () => (zonesInGh.length ? projectGeometry(zonesInGh) : null),
    [zonesInGh],
  );

  const zoneObs: Record<string, ZoneObs> = useMemo(() => {
    if (!diagnose) return {};
    // Server-aggregated counts come back as plain dicts; we just trust them.
    // Color overrides via colorFor() let a fresh legend tweak surface
    // without bumping the server cache.
    const out: Record<string, ZoneObs> = {};
    for (const [zone, obs] of Object.entries(diagnose.zoneObs)) {
      out[zone] = {
        count: obs.count,
        color: obs.color, // already resolved from the doctype legend server-side
        kind: obs.kind,
      };
    }
    return out;
  }, [diagnose]);

  // Markers for the BedSvg layer. One per affected zone, color +
  // shape inherited from the diagnose result.
  const bedMarkers: BedMarker[] = useMemo(
    () =>
      Object.entries(zoneObs).map(([zone, obs]) => ({
        zone,
        count: obs.count,
        kind: (obs.kind === "disease" ? "disease" : "pest") as
          | "pest"
          | "disease",
        color: obs.color,
      })),
    [zoneObs],
  );

  const latestScoutingDate = useMemo(
    () => diagnose?.latestDate ?? null,
    [diagnose],
  );

  const filterOpts = useMemo(() => {
    const pests = new Set<string>();
    const stages = new Set<string>();
    const sections = new Set<string>();
    if (diagnose) {
      diagnose.filterOpts.pests.forEach((p) => pests.add(p));
      diagnose.filterOpts.stages.forEach((s) => stages.add(s));
      diagnose.filterOpts.sections.forEach((s) => sections.add(s));
    }
    return {
      pests: Array.from(pests).sort(),
      stages: Array.from(stages).sort(),
      sections: Array.from(sections).sort(),
    };
  }, [diagnose]);

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
    () => bootstrap?.greenhouses.map((g) => g.name) || [],
    [bootstrap],
  );
  const bomList = useMemo(
    () =>
      (bootstrap?.tank_mixes || []).map((t) => ({
        name: t.name,
        item_name: t.item_name,
        custom_farm: t.custom_farm,
      })),
    [bootstrap],
  );
  const kitList = useMemo(
    () =>
      (bootstrap?.kits || []).map((k) => ({
        kit: k.kit,
        warehouse: k.warehouse,
      })),
    [bootstrap],
  );

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
    if (!greenhouse || !sprayDate || !sprayType || !scope || !bom || !kit || !classification) {
      pushToast("err", "Fill in greenhouse, date, spray type, scope, kit, BOM and classification.");
      return;
    }
    if (classification === "Preventive" && preventiveReason.trim().length < 20) {
      pushToast("err", "Preventive plans need a reason of at least 20 characters.");
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
      const limitErr = rateLimitError(c.item_code, c.stock_qty, rateLimits);
      if (limitErr) {
        pushToast("err", `${c.item_name || c.item_code}: ${limitErr}`);
        return;
      }
    }
    if (!waterPh || !waterHardness) {
      pushToast("err", "Water pH and hardness are required.");
      return;
    }
    if (scope === "Specific Variety" && !selectedVarieties.size) {
      pushToast("err", "Pick at least one variety.");
      return;
    }
    if (scope === "Specific Bed(s)" && !bedNumbers.trim()) {
      pushToast("err", "Enter the bed numbers (e.g. 1-5, 7, 9).");
      return;
    }

    const targetsList = Array.from(selectedTargets);
    if (!targetsList.length) {
      pushToast("err", "Pick at least one target.");
      return;
    }

    const customScopeDetails =
      scope === "Specific Variety"
        ? Array.from(selectedVarieties).join(",")
        : scope === "Specific Bed(s)"
          ? bedNumbers.trim()
          : "";

    const loaderId = pushToast("loading", "Submitting spray plan…", 0);
    setBusy(true);
    try {
      const draftPayload = {
        custom_greenhouse: greenhouse,
        custom_classification: classification,
        custom_preventive_reason: preventiveReason,
        custom_spray_type: sprayType,
        custom_scope: scope,
        custom_scope_details: customScopeDetails,
        custom_kit: kit,
        custom_spray_team: sprayTeam || null,
        custom_water_ph: parseFloat(waterPh) || 0,
        custom_water_hardness: parseFloat(waterHardness) || 0,
        custom_water_volume: parseFloat(waterVolume) || 0,
        custom_area: parseFloat(area) || 0,
        custom_targets: targetsList,
        production_item: bom,
        chemicals: chemRows.map((c) => ({
          item_code: c.item_code,
          item_name: c.item_name,
          uom: c.stock_uom,
          source_warehouse: c.source,
          application_rate: c.stock_qty,
        })),
        custom_scheduled_application_time: sprayDate || null,
      };
      const r = await createDraftSprayPlan(draftPayload as Parameters<typeof createDraftSprayPlan>[0]);
      const woName = r?.work_order;
      dismissToast(loaderId);
      pushToast(
        "ok",
        woName ? `Added ${woName} to your draft batch.` : "Plan added to batch.",
      );
      // Reset form so the user can build the next plan in the batch
      setClassification("");
      setPreventiveReason("");
      setSelectedTargets(new Set());
      setChemRows([]);
      setBom("");
      // Notify the draft batch panel (mounted in Task 5) to refresh
      window.dispatchEvent(new CustomEvent("spray-plan:draft-added"));
    } catch (e: any) {
      dismissToast(loaderId);
      pushToast("err", e?.message || "Submission failed");
    } finally {
      setBusy(false);
    }
  };

  // ── BOM creation ────────────────────────────────────────────────
  const addNewBomChem = (it: ChemicalItem) => {
    if (newBomChems.some((c) => c.item_code === it.item_code)) return;
    setNewBomChems((prev) => [...prev, it]);
    setNewBomSearch("");
  };
  const removeNewBomChem = (code: string) =>
    setNewBomChems((prev) => prev.filter((c) => c.item_code !== code));

  const submitNewBom = async () => {
    if (!newBomItem.trim()) {
      pushToast("err", "BOM name is required.");
      return;
    }
    if (!newBomChems.length) {
      pushToast("err", "Add at least one chemical to the BOM.");
      return;
    }
    setCreatingBom(true);
    const loaderId = pushToast("loading", "Creating BOM…", 0);
    try {
      const r = await createBom({
        item: newBomItem.trim(),
        custom_water_ph: parseFloat(newBomPh) || 0,
        custom_water_hardness: parseFloat(newBomHardness) || 0,
        items: newBomChems.map((c) => ({
          item_code: c.item_code,
          item_name: c.item_name,
          qty: 1,
          stock_uom: c.stock_uom,
        })),
        custom_greenhouse: greenhouse || undefined,
      });
      dismissToast(loaderId);
      if (r.status === "success" && r.bom_name) {
        pushToast("ok", `Created BOM ${r.bom_name}.`);
        // Refresh bootstrap so the new BOM appears in the dropdown,
        // then auto-select it.
        const fresh = await fetchCreatorBootstrap();
        setBootstrap(fresh);
        setBom(r.bom_name);
        setBomDialogOpen(false);
        setNewBomItem("");
        setNewBomChems([]);
        setNewBomSearch("");
      } else {
        pushToast("err", r.message || "Could not create BOM.");
      }
    } catch (e: any) {
      dismissToast(loaderId);
      pushToast("err", e?.message || "Could not create BOM.");
    } finally {
      setCreatingBom(false);
    }
  };

  if (bootstrapError) {
    return <AccessGate error={bootstrapError} />;
  }
  if (bootstrap && bootstrap.scope.farms.length === 0) {
    return <NoFarmsGate />;
  }

  return (
    <div className="flex flex-col min-h-svh">
      <MarkerDefs />
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
            {greenhouse && geometry ? (
              <button
                type="button"
                onClick={() => setHeatmapModal(true)}
                className="block w-full text-left"
                title="Click for full-screen view"
              >
                <BedSvg
                  geometry={geometry}
                  markers={bedMarkers}
                  className="w-full h-auto min-h-[260px] max-h-[360px] hover:ring-2 hover:ring-[var(--sd-accent)]/30 transition-shadow rounded-md border bg-card p-2"
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
                <Label>Classification</Label>
                <div className="flex gap-2">
                  {(["Curative", "Preventive"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setClassification(c)}
                      className={
                        "px-3 py-1.5 rounded-md border text-xs transition-colors " +
                        (classification === c
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-muted hover:bg-muted/70")
                      }
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {classification === "Preventive" && (
                <div className="flex flex-col gap-1 col-span-2">
                  <Label className="flex items-center justify-between">
                    <span>Preventive Reason</span>
                    <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                      required (min 20 chars)
                    </span>
                  </Label>
                  <textarea
                    value={preventiveReason}
                    onChange={(e) => setPreventiveReason(e.target.value)}
                    placeholder="Why does this routine spray make sense without an observation trigger?"
                    rows={3}
                    className="w-full rounded-md border bg-background px-3 py-2 text-xs"
                  />
                </div>
              )}

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

              {scope === "Specific Variety" && (
                <div className="flex flex-col gap-1 col-span-2">
                  <Label>Varieties</Label>
                  {varietiesInGh.length ? (
                    <div className="flex flex-wrap gap-1.5 rounded-md border bg-card p-2 max-h-40 overflow-auto">
                      {varietiesInGh.map((v) => {
                        const on = selectedVarieties.has(v);
                        return (
                          <button
                            key={v}
                            type="button"
                            onClick={() =>
                              setSelectedVarieties((prev) => {
                                const next = new Set(prev);
                                if (next.has(v)) next.delete(v);
                                else next.add(v);
                                return next;
                              })
                            }
                            className={
                              "px-2 py-0.5 rounded-full text-[0.7rem] border transition-colors " +
                              (on
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted hover:bg-muted/70")
                            }
                          >
                            {v}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No varieties recorded for this greenhouse.
                    </span>
                  )}
                </div>
              )}

              {scope === "Specific Bed(s)" && (
                <div className="flex flex-col gap-1 col-span-2">
                  <Label>Bed Numbers</Label>
                  <Input
                    value={bedNumbers}
                    onChange={(e) => setBedNumbers(e.target.value)}
                    placeholder="e.g. 1-5, 7, 9"
                    className="h-9"
                  />
                  <span className="text-[0.65rem] text-muted-foreground">
                    Use ranges with hyphens and commas — same format as the
                    legacy spray-plan page.
                  </span>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <Label className="flex items-center justify-between">
                  <span>Area (Ha)</span>
                  {areaHa > 0 && (
                    <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                      auto
                    </span>
                  )}
                </Label>
                <Input
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                  type="number"
                  step="any"
                  min={0}
                  placeholder={
                    areaHa > 0 ? areaHa.toFixed(4) : "Pick scope to compute"
                  }
                  className="h-9 tabular-nums"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label>Spray Team</Label>
                <Select value={sprayTeam} onValueChange={setSprayTeam}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Pick a team" />
                  </SelectTrigger>
                  <SelectContent>
                    {(bootstrap?.spray_teams || []).map((t) => (
                      <SelectItem key={t.name} value={t.name}>
                        {t.name}
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
                <Label className="flex items-center justify-between">
                  <span>Targets</span>
                  <span className="text-[0.6rem] uppercase tracking-wide text-muted-foreground">
                    {selectedTargets.size} selected
                  </span>
                </Label>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {(() => {
                    const sourceList =
                      classification === "Preventive"
                        ? [
                            ...(bootstrap?.pest_catalog || []).map((p) => p.name),
                            ...(bootstrap?.disease_catalog || []).map((d) => d.name),
                          ]
                        : (diagnose?.targets ?? []);
                    if (!sourceList.length) {
                      return (
                        <span className="text-xs text-muted-foreground">
                          {classification === "Preventive"
                            ? "Pest + Disease catalog is empty — add entries in Frappe Desk."
                            : classification === "Curative"
                              ? "No pest/disease observations in the chosen greenhouse yet."
                              : "Pick Classification first."}
                        </span>
                      );
                    }
                    return sourceList.sort().map((t) => {
                      const on = selectedTargets.has(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            setSelectedTargets((prev) => {
                              const next = new Set(prev);
                              if (next.has(t)) next.delete(t);
                              else next.add(t);
                              return next;
                            })
                          }
                          className={
                            "px-2 py-0.5 rounded-full text-[0.7rem] border transition-colors " +
                            (on
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-muted hover:bg-muted/70")
                          }
                        >
                          {t}
                        </button>
                      );
                    });
                  })()}
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
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1"
                  onClick={() => setBomDialogOpen(true)}
                >
                  <FilePlus2 className="h-3.5 w-3.5" />
                  New
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
                  <div className="grid grid-cols-3 gap-2">
                    <NumInput label="Water pH" value={waterPh} onChange={setWaterPh} />
                    <NumInput
                      label="Hardness"
                      value={waterHardness}
                      onChange={setWaterHardness}
                    />
                    <NumInput
                      label="Water Volume (L)"
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
                                  {(() => {
                                    const limitErr = rateLimitError(
                                      c.item_code,
                                      c.stock_qty,
                                      rateLimits,
                                    );
                                    return (
                                      <>
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
                                          aria-invalid={!!limitErr}
                                          className={
                                            limitErr
                                              ? "h-7 text-xs text-right tabular-nums w-20 ml-auto border-[var(--sd-data-red)] focus-visible:ring-[var(--sd-data-red)]"
                                              : "h-7 text-xs text-right tabular-nums w-20 ml-auto"
                                          }
                                        />
                                        <div className="text-[0.65rem] text-muted-foreground mt-0.5">
                                          {c.stock_uom || ""}
                                        </div>
                                        {limitErr && (
                                          <div className="text-[0.65rem] text-[var(--sd-data-red)] mt-0.5 max-w-[10rem] ml-auto text-right">
                                            {limitErr}
                                          </div>
                                        )}
                                      </>
                                    );
                                  })()}
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
            Add to batch
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
          {geometry ? (
            <BedSvg
              geometry={geometry}
              markers={bedMarkers}
              className="w-full h-auto min-h-[420px] [&_svg]:max-h-[640px] [&_svg]:w-full"
            />
          ) : (
            <div className="text-xs text-muted-foreground p-4">
              Zone geometry not available for this greenhouse.
            </div>
          )}
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

      {/* Create-BOM dialog (legacy parity) */}
      <Dialog open={bomDialogOpen} onOpenChange={setBomDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Create new Chemical Mix BOM</DialogTitle>
            <DialogDescription>
              Inline BOM creation — same fields as the legacy spray-plan page.
              The new BOM is auto-selected on success.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label>BOM Name</Label>
              <Input
                value={newBomItem}
                onChange={(e) => setNewBomItem(e.target.value)}
                placeholder="e.g. Botrytis Mix · Greenhouse 12"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumInput
                label="Water pH"
                value={newBomPh}
                onChange={setNewBomPh}
              />
              <NumInput
                label="Water Hardness"
                value={newBomHardness}
                onChange={setNewBomHardness}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Add chemical</Label>
              <Input
                value={newBomSearch}
                onChange={(e) => setNewBomSearch(e.target.value)}
                placeholder="Search…"
              />
              {newBomSearch && newBomSearchResults.length > 0 && (
                <div className="rounded-md border bg-card max-h-40 overflow-auto">
                  {newBomSearchResults.map((it) => (
                    <button
                      key={it.item_code}
                      type="button"
                      onClick={() => addNewBomChem(it)}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted border-b last:border-b-0"
                    >
                      <span className="font-medium">
                        {it.item_name || it.item_code}
                      </span>
                      <span className="ml-2 text-[0.65rem] text-muted-foreground font-mono">
                        {it.item_code}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {newBomChems.length > 0 && (
              <div className="rounded-md border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Chemical</TableHead>
                      <TableHead>UoM</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {newBomChems.map((c) => (
                      <TableRow key={c.item_code}>
                        <TableCell className="text-xs">
                          <div className="font-medium">
                            {c.item_name || c.item_code}
                          </div>
                          <div className="text-[0.65rem] text-muted-foreground font-mono">
                            {c.item_code}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {c.stock_uom || ""}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground"
                            onClick={() => removeNewBomChem(c.item_code)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                onClick={() => setBomDialogOpen(false)}
                disabled={creatingBom}
              >
                Cancel
              </Button>
              <Button onClick={submitNewBom} disabled={creatingBom}>
                {creatingBom ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Create BOM
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}

function AccessGate({ error }: { error: { status: number; message: string } }) {
  return (
    <div className="flex flex-col min-h-svh items-center justify-center px-4">
      <Card className="max-w-md border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base text-destructive">
            {error.status === 403 ? "Access denied" : "Cannot load spray plan tools"}
          </CardTitle>
          <CardDescription>
            {error.status === 403
              ? "This page is restricted to users with the 'Spray Plan Creator' role. Ask a General Manager to grant you the role."
              : error.message}
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function NoFarmsGate() {
  return (
    <div className="flex flex-col min-h-svh items-center justify-center px-4">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="text-base">No farms assigned yet</CardTitle>
          <CardDescription>
            You hold the 'Spray Plan Creator' role but no farm has been assigned to you.
            Ask a General Manager to add you on the Spray Plan Access page.
          </CardDescription>
        </CardHeader>
      </Card>
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
