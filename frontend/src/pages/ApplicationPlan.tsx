import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, Maximize2 } from "lucide-react";
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
import { PlacePicker } from "@/components/PlacePicker";
import { farmOf } from "@/lib/places";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CurativeAlerts, alertLinkFor } from "@/components/spray-plan/CurativeAlerts";
import { ghActionBadge, type CreatorAlert } from "@/lib/scouting-alerts-api";
import { PageHeader } from "@/components/PageHeader";
import { useToast, type ToastItem } from "@/components/Toast";
import { parseReplanParams, pendingNote, resolveReplan } from "./replanPrefill";
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
import { MarkerDefs, iconKeyToShape } from "./maps/MarkerDefs";
import { BedSvg, type BedMarker, type ZoneStage } from "./maps/BedSvg";
import { StageLegend, HeatRampLegend } from "./maps/StageLegend";
import {
  projectGeometry,
  type ProjectedGeometry,
  type ZoneGeoLike,
} from "./maps/bed-projection";
import {
  fetchBedsAndZones,
  fetchBedsByGreenhouse,
  fetchZonesByGreenhouse,
  searchChemicalItems,
  type BedAreaRow,
  type ChemicalItem,
  type RateLimit,
  type VarietyNode,
} from "@/lib/scouting-api";
import { SuggestedProductsCard } from "@/components/spray-plan/SuggestedProducts";
import { ActiveIngredients } from "@/components/spray-plan/ActiveIngredients";
import {
  createDraftSprayPlan,
  fetchCreatorBootstrap,
  type CreatorBootstrap,
} from "@/lib/spray-plan-creator-api";
import { DraftBatchPanel } from "@/components/spray-plan/DraftBatchPanel";
import { SprayPlanForm } from "@/components/spray-plan/plan-form/SprayPlanForm";
import { useSprayPlanForm, type PlanChemical } from "@/components/spray-plan/plan-form/useSprayPlanForm";
import { newBomRateError, rateLimitError, type NewBomChem } from "@/components/spray-plan/plan-form/plan-form-utils";
import { SprayCheckCard } from "@/components/spray-plan/SprayCheckCard";
import { OverrideDialog } from "@/components/spray-plan/OverrideDialog";
import {
  checkSprayPlan,
  eligibleBoms,
  eligibleProducts,
  mixIngredients,
  saveGate,
  type BomEligibility,
  type CheckResult,
  type MixIngredients,
  type OverrideInput,
  type ProductEligibility,
  type SuggestedProduct,
} from "@/lib/spray-compliance-api";
import { WeatherCard } from "@/components/WeatherCard";
import { Bar, LoadProgress, TextSkeleton, firstLoad } from "@/components/Loading";
import {
  SprayTeamEditor,
  type TeamMemberRow,
} from "@/components/spray-plan/SprayTeamEditor";
import { FrappeError } from "@/lib/frappe";
import { asStatement, errorText, explainError } from "@/lib/errors";
import { mergeDateTime, splitDateTime, ymd } from "@/lib/utils";
import {
  pestColor,
  diseaseColor,
  useObservationColors,
} from "@/lib/observation-colors";
interface ZoneObs {
  count: number;
  color: string;
  kind?: "pest" | "disease";
  stages?: ZoneStage[];
}

interface DiagnosePayload {
  zoneObs: Record<string, ZoneObs>;
  latestDate: string | null;
  filterOpts: {
    pests: string[];
    sections: string[];
    stages: string[];
    stagesByObs?: Record<string, string[]>;
    sectionsByObs?: Record<string, string[]>;
  };
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

/** A tank-mix row of the plan (the shared plan form's row). */
type ChemRow = PlanChemical & { rowId: string };

// Moved to the shared plan form; re-exported for the dose-validation tests.
export { newBomRateError, type NewBomChem };

export function ApplicationPlan({ initialCrop }: { initialCrop?: string } = {}) {
  const [bootstrap, setBootstrap] = useState<CreatorBootstrap | null>(null);
  const [bootstrapError, setBootstrapError] = useState<{ status: number; message: string } | null>(null);
  const [varietyTree, setVarietyTree] = useState<VarietyNode[]>([]);
  /** the zone polygons have been fetched (or failed): a house with none is then "no map", not loading */
  const [zonesLoaded, setZonesLoaded] = useState(false);
  const [bedsByGh, setBedsByGh] = useState<Record<string, BedAreaRow[]>>({});
  const [zonesByGh, setZonesByGh] = useState<Record<string, number>>({});
  // Per-chemical application-rate bounds (Item.custom_lower/upper_rate_limit).
  // Empty by default; populated once at mount so the rate inputs can flag
  // out-of-range values inline as the operator types.
  const [rateLimits, setRateLimits] = useState<Record<string, RateLimit>>({});
  // Farm filter: scopes the greenhouse picker (and everything downstream)
  // to the chosen farm. ``""`` means "all my allowed farms"; the list comes
  // from ``bootstrap.scope.farms`` which is already trimmed server-side to
  // Spray Plan Settings.allowed_farms for the current user.
  const [greenhouse, setGreenhouse] = useState<string>("");
  // The Scouting Alert a curative plan is being made from (thresholds D7). The
  // prefill ref survives the greenhouse/classification reset effect below.
  const [curativeAlert, setCurativeAlert] = useState<string>("");
  const prefillRef = useRef<{ greenhouse: string; target: string } | null>(null);
  // Re-plan link from the Approvals Stale tab: parsed once, applied when the bootstrap lands.
  const replanRef = useRef(
    typeof window !== "undefined" ? parseReplanParams(window.location.hash) : null,
  );
  const replanTargetsRef = useRef<{ greenhouse: string; targets: string[] } | null>(null);
  const [replanWo, setReplanWo] = useState<string>("");
  const [replanPending, setReplanPending] = useState<ChemicalItem[]>([]);
  const [diag, setDiag] = useState<DiagnoseFilters>({
    pest: ALL,
    stage: ALL,
    section: ALL,
  });
  // Subscribe to the live doctype colour map; we don't need its return
  // value because `colorFor` reads the module-level cache, but mounting
  // the hook here ensures the diagnose plot redraws after the fetch.
  useObservationColors();

  // Spray state. The plan itself (classification, Scheduled Application, team,
  // kit, tank mix, chemicals, water) lives in the shared plan form's hook below.
  const [sprayType, setSprayType] = useState<string>("");
  const [scope, setScope] = useState<string>("");
  const [suggestedCodes, setSuggestedCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Cost-center override. Defaults to the auto-resolved value for the
  // picked greenhouse (read from bootstrap.greenhouses[].cost_center).
  // The operator can type or pick another Cost Center; the override only
  // travels with the submit payload when it differs from the default.
  const [costCenterOverride, setCostCenterOverride] = useState<string>("");
  const [costCenterEditing, setCostCenterEditing] = useState<boolean>(false);

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
  // Per-plan team roster. Seeded from a picked Spray Team but editable
  // without mutating the master `Spray Team Details`. Submitted as the
  // WO's `custom_spray_plan_team_members` child table.
  const [teamMembers, setTeamMembers] = useState<TeamMemberRow[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  // Heatmap fullscreen modal
  const [heatmapModal, setHeatmapModal] = useState(false);

  // Floating toasts (components/Toast.tsx), the same as Livestock and the desk.
  const toast = useToast();
  const pushToast = (
    kind: ToastItem["kind"],
    text: string,
    autoMs?: number,
    hint?: string,
  ) => toast.show(asStatement(text), kind, { hint, ms: autoMs });
  /** Server errors get the statement on one line and what to do on the next,
   *  rather than one long run-on sentence. */
  const pushError = (e: unknown, fallback?: string) => {
    const h = explainError(e, fallback);
    return pushToast("err", h.text, h.kind === "bug" ? 12000 : 8000, h.hint);
  };
  const dismissToast = toast.dismiss;

  // Diagnose-step data: per-zone counts + filter options for the currently
  // selected greenhouse. One server endpoint replaces the old
  // useScouting-pulls-everything pattern.
  const [{ from, to }] = useState(defaultRange);
  const diagnoseFilters = useMemo(
    () => ({
      greenhouse,
      from_date: from,
      to_date:   to,
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
  // Counts fetched for ANOTHER greenhouse are not shown under this one's title
  // (nor fed to targets); a filter change within the same house keeps them up.
  const diagnose =
    diagnoseState.dataFilters?.greenhouse === greenhouse ? diagnoseState.data : null;
  const loading = diagnoseState.loading;
  // The diagnose aggregate's first load for this greenhouse: the step's frame
  // (labels, chips row, heatmap box) stands; its figures pulse.
  const diagSkeleton =
    !!greenhouse && firstLoad(loading || (!diagnose && !diagnoseState.error), !!diagnose);

  useEffect(() => {
    let cancelled = false;
    fetchCreatorBootstrap(initialCrop)
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
          setBootstrapError({ status: 0, message: errorText(e) });
        }
      });
    fetchBedsAndZones()
      .then((v) => !cancelled && setVarietyTree(v))
      .catch(() => {})
      .finally(() => !cancelled && setZonesLoaded(true));
    fetchZonesByGreenhouse().then((z) => !cancelled && setZonesByGh(z));
    fetchBedsByGreenhouse().then((b) => !cancelled && setBedsByGh(b));
    return () => {
      cancelled = true;
    };
  }, []);

  /** Farm of the picked greenhouse — drives the "wrong store" amber
   *  warning on the Chemical Stock matrix and the farm→store lookup below.
   *  Empty when no greenhouse is selected, in which case both checks are
   *  skipped entirely. Declared above the BOM loader (rather than near
   *  its original home further down) because that effect needs
   *  ``mappedStores`` to force each row's source. */
  const greenhouseFarm = useMemo(() => {
    if (!greenhouse) return "";
    return (
      bootstrap?.greenhouses.find((g) => g.name === greenhouse)?.custom_farm ||
      ""
    );
  }, [greenhouse, bootstrap]);

  /** The greenhouse's farm's mapped chemical/fertilizer store, if any
   *  (Task 5/9). When set for a given chemical group, the source
   *  warehouse for that group is LOCKED — no dropdown, single stock
   *  column — instead of the free-choice picker used for unmapped farms. */
  const mappedStores = useMemo(() => {
    if (!greenhouseFarm) return null;
    return bootstrap?.farm_stores?.[greenhouseFarm] || null;
  }, [greenhouseFarm, bootstrap]);

  // The plan form: tank mix, chemicals, stock, batches, water and the plan's own
  // fields (components/spray-plan/plan-form), shared with the field planner.
  const form = useSprayPlanForm({
    place: greenhouse,
    placeKind: "greenhouse",
    crop: initialCrop,
    farm: greenhouseFarm,
    areaHa: parseFloat(area) || 0,
    stores: mappedStores,
    rateLimits,
  });
  const {
    scheduledAt: sprayDate,
    setScheduledAt: setSprayDate,
    bom,
    setBom,
    bomDetails,
    bomLoading,
    kit,
    classification,
    setClassification,
    reason: preventiveReason,
    team: sprayTeam,
    setTeam: setSprayTeam,
    waterPh,
    waterHardness,
    water: waterVolume,
    setWater: setWaterVolume,
    setChemicals: setChemRows,
    rowAvailable,
    batchMissingRows,
    stockShortRows,
    stockShortById,
    makeChemRow,
    addChemical,
    setSource,
  } = form;
  // The form gives every row a rowId (tank-mix rows and added ones alike).
  const chemRows = form.chemicals as ChemRow[];

  // Reset scope-detail extras when the scope or greenhouse changes.
  useEffect(() => {
    setSelectedVarieties(new Set());
    setBedNumbers("");
  }, [scope, greenhouse]);

  useEffect(() => {
    const p = prefillRef.current;
    prefillRef.current = null;
    if (p && p.greenhouse === greenhouse && classification === "Curative") {
      setSelectedTargets(new Set([p.target]));
      return;
    }
    const r = replanTargetsRef.current;
    if (r && r.greenhouse === greenhouse && classification === "Curative") {
      replanTargetsRef.current = null;
      setSelectedTargets(new Set(r.targets));
      return;
    }
    setSelectedTargets(new Set());
    setCurativeAlert("");
  }, [greenhouse, classification]);

  // Apply a Re-plan link once the bootstrap (greenhouses, catalogs) is known.
  useEffect(() => {
    const p = replanRef.current;
    if (!p || !bootstrap) return;
    replanRef.current = null;
    const res = resolveReplan(p, {
      greenhouses: (bootstrap.greenhouses || []).map((g) => g.name),
      targets: [
        ...(bootstrap.pest_catalog || []).map((x) => x.name),
        ...(bootstrap.disease_catalog || []).map((x) => x.name),
      ],
    });
    // The query is spent whether or not it applied: a refresh must not re-apply it.
    try {
      window.history.replaceState(null, "", window.location.hash.split("?")[0] || "#/");
    } catch {
      /* ignore */
    }
    setReplanWo(p.replan);
    if (res.greenhouse) setGreenhouse(res.greenhouse);
    if (res.date) setSprayDate((cur) => mergeDateTime(res.date, splitDateTime(cur).time));
    if (res.targets.length) {
      replanTargetsRef.current = { greenhouse: res.greenhouse || greenhouse, targets: res.targets };
      setClassification("Curative");
    }
    let cancelled = false;
    void (async () => {
      const found = await Promise.all(
        p.items.map(async (code) => {
          const rows = await searchChemicalItems(code);
          return rows.find((r) => r.item_code === code) || null;
        }),
      );
      if (cancelled) return;
      const skipped = [...res.skipped];
      p.items.forEach((code, i) => {
        if (!found[i]) skipped.push(`item ${code}`);
      });
      setReplanPending(found.filter((x): x is ChemicalItem => !!x));
      if (skipped.length) {
        pushToast("err", `Skipped from the stale plan: ${skipped.join(", ")}`, 10000);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootstrap]);

  // Deselecting the alert's pest unlinks the plan from it (saves as an
  // ordinary curative plan); the server refuses the mismatch too.
  useEffect(() => {
    setCurativeAlert((cur) => alertLinkFor(bootstrap?.alerts?.[greenhouse], cur, selectedTargets));
  }, [selectedTargets, bootstrap, greenhouse]);

  const startCurative = useCallback(
    (a: CreatorAlert) => {
      if (greenhouse !== a.warehouse || classification !== "Curative") {
        prefillRef.current = { greenhouse: a.warehouse, target: a.observation };
      }
      setGreenhouse(a.warehouse);
      setClassification("Curative");
      setCurativeAlert(a.name);
      // When neither changed the effect does not run; set the target directly.
      setSelectedTargets(new Set([a.observation]));
    },
    [greenhouse, classification],
  );

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
          out.push({ name: z.name, coords: z.coords, lineId: z.lineId });
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
        stages: obs.stages,
      };
    }
    return out;
  }, [diagnose]);

  // Markers for the BedSvg layer. One marker per (zone, stage), shaped by the
  // stage's catalog icon_key (same stage => same shape across pests), coloured
  // by the zone's observation legend. Falls back to one kind-shaped marker per
  // zone when a zone has no per-stage breakdown.
  const bedMarkers: BedMarker[] = useMemo(
    () =>
      Object.entries(zoneObs).flatMap(([zone, obs]): BedMarker[] => {
        if (obs.stages && obs.stages.length) {
          return obs.stages.map((s) => ({
            zone,
            count: s.count,
            color: obs.color,
            shape: iconKeyToShape(s.icon_key),
            stage: s.stage,
          }));
        }
        return [
          {
            zone,
            count: obs.count,
            kind: (obs.kind === "disease" ? "disease" : "pest") as
              | "pest"
              | "disease",
            color: obs.color,
          },
        ];
      }),
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

  // Stage / Plant Section chips narrow to whatever's seen for the
  // currently picked Pest. ``ALL`` = show every stage / section in scope.
  const stagesForPest = useMemo(() => {
    if (diag.pest === ALL) return filterOpts.stages;
    const map = diagnose?.filterOpts.stagesByObs;
    return map?.[diag.pest] || [];
  }, [diag.pest, diagnose, filterOpts.stages]);

  const sectionsForPest = useMemo(() => {
    if (diag.pest === ALL) return filterOpts.sections;
    const map = diagnose?.filterOpts.sectionsByObs;
    return map?.[diag.pest] || [];
  }, [diag.pest, diagnose, filterOpts.sections]);

  // If the user switches pests and the previously-picked stage/section
  // doesn't exist for the new pest, drop the stale filter so the user
  // isn't silently looking at zero zones.
  useEffect(() => {
    if (diag.stage !== ALL && !stagesForPest.includes(diag.stage)) {
      setDiag((d) => ({ ...d, stage: ALL }));
    }
    if (diag.section !== ALL && !sectionsForPest.includes(diag.section)) {
      setDiag((d) => ({ ...d, section: ALL }));
    }
  }, [diag.pest, diag.stage, diag.section, stagesForPest, sectionsForPest]);

  const totalZones = greenhouse ? zonesByGh[greenhouse] || 0 : 0;
  const affectedZones = Object.values(zoneObs).filter((o) => o.count > 0).length;
  const coveragePct = totalZones
    ? Math.round((affectedZones / totalZones) * 1000) / 10
    : 0;
  const allowedFarms = useMemo(
    () => bootstrap?.scope.farms || [],
    [bootstrap],
  );
  // Effective farm for the weather card: the selected greenhouse's farm >
  // single allowed farm. Stays empty when ambiguous (multiple farms allowed,
  // no selection yet) so we don't pick wrong.
  const weatherFarm = useMemo(() => {
    if (greenhouse) {
      const g = bootstrap?.greenhouses.find((x) => x.name === greenhouse);
      if (g?.custom_farm) return g.custom_farm;
    }
    if (allowedFarms.length === 1) return allowedFarms[0];
    return "";
  }, [greenhouse, bootstrap, allowedFarms]);
  const ghList = useMemo(
    () => (bootstrap?.greenhouses || []).map((g) => g.name),
    [bootstrap],
  );

  // Drop a pick the bootstrap no longer lists, so downstream calcs don't run
  // on a GH the user can no longer see in the picker.
  useEffect(() => {
    if (!greenhouse) return;
    if (!ghList.includes(greenhouse)) setGreenhouse("");
  }, [ghList, greenhouse]);
  // farm → greenhouses for the picker; a house with no farm link falls back to
  // the farm its name starts with.
  const ghByFarm = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const g of bootstrap?.greenhouses || []) {
      const f = g.custom_farm || farmOf(g.name, allowedFarms) || "Other";
      (out[f] ||= []).push(g.name);
    }
    return out;
  }, [bootstrap, allowedFarms]);
  const derivedCostCenter = useMemo(() => {
    if (!greenhouse) return null;
    const match = bootstrap?.greenhouses.find((g) => g.name === greenhouse);
    return match?.cost_center || null;
  }, [bootstrap, greenhouse]);
  const costCenterOptions = useMemo(
    () => bootstrap?.cost_centers || [],
    [bootstrap],
  );
  // Effective cost center to display + send: override wins when set, else
  // the auto-resolved value. Trimmed so a whitespace-only override doesn't
  // count as "edited".
  const effectiveCostCenter = (costCenterOverride.trim() || derivedCostCenter || "").trim();
  const isCostCenterCustom =
    !!costCenterOverride.trim() && costCenterOverride.trim() !== (derivedCostCenter || "");

  // Reset the override whenever the greenhouse changes — the operator's
  // previous override is only meaningful for the previous greenhouse.
  useEffect(() => {
    setCostCenterOverride("");
    setCostCenterEditing(false);
  }, [greenhouse]);
  const bomList = useMemo(
    () =>
      (bootstrap?.tank_mixes || []).map((t) => ({
        name: t.name,
        item_name: t.item_name,
        custom_farm: t.custom_farm,
      })),
    [bootstrap],
  );
  // ── Spray check ─────────────────────────────────────────────────
  // The server judges the mix against the picked targets; the page only
  // shows the verdict and gates the save on it.
  const [bomElig, setBomElig] = useState<Record<string, BomEligibility>>({});
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [productInfo, setProductInfo] = useState<Record<string, ProductEligibility>>({});
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [pendingOverrides, setPendingOverrides] = useState<OverrideInput[] | null>(null);
  const targetsArr = useMemo(() => Array.from(selectedTargets).sort(), [selectedTargets]);
  // Keyed on the item list, not the rows, so editing a rate does not re-check.
  const mixKey = useMemo(() => chemRows.map((c) => c.item_code).join("\u0001"), [chemRows]);
  const mixItems = useMemo(() => (mixKey ? mixKey.split("\u0001") : []), [mixKey]);

  // Active ingredients of the mix rows and what this plan uses of each: the quantity is the
  // row's required qty as computed above (rate x water volume), so it follows every edit.
  const [mixIngr, setMixIngr] = useState<MixIngredients>({});
  const ingrKey = JSON.stringify([
    chemRows.map((c) => [c.item_code, c.stock_qty, c.stock_uom]),
    area,
  ]);
  useEffect(() => {
    if (!chemRows.length) {
      setMixIngr({});
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      mixIngredients(
        chemRows.map((c) => ({ item_code: c.item_code, qty: Number(c.stock_qty) || 0, uom: c.stock_uom })),
        parseFloat(area) || 0,
      )
        .then((r) => !cancelled && setMixIngr(r))
        .catch(() => !cancelled && setMixIngr({}));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingrKey]);

  useEffect(() => {
    if (!greenhouse || !targetsArr.length || !bomList.length) {
      setBomElig({});
      return;
    }
    let cancelled = false;
    // Debounced like the check below: ticking targets one by one fires once.
    const t = setTimeout(() => {
      eligibleBoms({ greenhouse, targets: targetsArr, boms: bomList.map((b) => b.name), when: sprayDate })
        .then((rows) => !cancelled && setBomElig(Object.fromEntries(rows.map((r) => [r.bom, r]))))
        .catch(() => !cancelled && setBomElig({}));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [greenhouse, targetsArr, bomList, sprayDate]);

  useEffect(() => {
    if (!greenhouse || !targetsArr.length || !mixItems.length) {
      setCheck(null);
      setProductInfo({});
      setCheckLoading(false);
      return;
    }
    let cancelled = false;
    setCheckLoading(true);
    const t = setTimeout(() => {
      // Settled separately: the per-product details failing must not drop the
      // check, which gates the save.
      Promise.allSettled([
        checkSprayPlan({ greenhouse, targets: targetsArr, items: mixItems, when: sprayDate }),
        eligibleProducts({ greenhouse, targets: targetsArr, items: [], candidates: mixItems, when: sprayDate }),
      ]).then(([r, info]) => {
        if (cancelled) return;
        setCheck(r.status === "fulfilled" ? r.value : null);
        setProductInfo(
          info.status === "fulfilled" ? Object.fromEntries(info.value.map((p) => [p.item, p])) : {},
        );
        setCheckLoading(false);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [greenhouse, targetsArr, mixItems, sprayDate]);

  // An override answers one particular check; a new check needs a new one.
  useEffect(() => {
    setPendingOverrides(null);
  }, [check]);

  const gate = useMemo(() => saveGate(check), [check]);

  /** Items named by a violation that has not been overridden. */
  const flaggedItems = useMemo(() => {
    const out = new Set<string>();
    for (const v of check?.violations ?? []) if (!v.overridden) v.products.forEach((i) => out.add(i));
    return out;
  }, [check]);

  const kitList = useMemo(
    () =>
      (bootstrap?.kits || []).map((k) => ({
        kit: k.kit,
        warehouse: k.warehouse,
      })),
    [bootstrap],
  );

  /** Same heuristic as the www page's ``warehouseMatchesFarm``: a source
   *  warehouse "belongs" to a farm if its name contains the farm name
   *  (case-insensitive). Used to soft-warn the operator when the picked
   *  source isn't from the greenhouse's farm — submission still goes
   *  through. */
  const warehouseMatchesFarm = useCallback(
    (wh: string) => {
      if (!greenhouseFarm) return true;
      return (wh || "").toLowerCase().includes(greenhouseFarm.toLowerCase());
    },
    [greenhouseFarm],
  );

  /** Per-row visual warning level for the Chemical Stock matrix:
   *   - "red"   = source picked AND avail < need (adjusted, draft-aware).
   *               Hard error; blocks Submit.
   *   - "amber" = source not picked yet, OR (unmapped farm only) source
   *               is from a different farm than the greenhouse. Soft
   *               warning; visual cue only, doesn't block submission on
   *               its own (but the "no source" case is also covered by
   *               stockShortRows so it still blocks). Locked (mapped)
   *               rows skip the farm-mismatch heuristic entirely — the
   *               mapped store is correct by definition.
   *   - null    = no warning. */
  const rowWarnById = useMemo(() => {
    const out = new Map<string, "amber" | "red">();
    for (const c of chemRows) {
      const need = c.stock_qty || 0;
      const source = c.source || "";
      const locked = c.is_fertilizer
        ? !!mappedStores?.fertilizer_store
        : !!mappedStores?.chemical_store;
      if (!source) {
        out.set(c.rowId, "amber");
        continue;
      }
      const avail = rowAvailable(c);
      if (need > 0 && avail < need) {
        out.set(c.rowId, "red");
        continue;
      }
      if (!locked && !warehouseMatchesFarm(source)) {
        out.set(c.rowId, "amber");
      }
    }
    return out;
  }, [chemRows, warehouseMatchesFarm, mappedStores, rowAvailable]);

  // Items queued by a Re-plan link join the tank mix once one is loaded (picking
  // a tank mix replaces the rows, so they cannot go in earlier).
  useEffect(() => {
    if (!replanPending.length || !bom || bomLoading || bomDetails?.name !== bom) return;
    const queue = replanPending;
    setReplanPending([]);
    void (async () => {
      const have = new Set(chemRows.map((r) => r.item_code));
      const rows: PlanChemical[] = [];
      for (const it of queue) {
        if (have.has(it.item_code)) continue;
        rows.push(
          await makeChemRow(
            it,
            rateLimits[it.item_code]?.lower ?? null,
            mappedStores?.chemical_store || undefined,
            chemRows.length + rows.length,
          ),
        );
      }
      setChemRows((prev) => [...prev, ...rows.filter((r) => !prev.some((p) => p.item_code === r.item_code))]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replanPending, bom, bomLoading, bomDetails]);

  /** One tap on a suggested tank mix: the tank mix's chemicals become exactly these products,
   *  each at its default rate (the page asked first when rows existed). */
  const addMix = async (products: SuggestedProduct[]) => {
    const store =
      mappedStores?.chemical_store || chemRows.find((c) => !c.is_fertilizer && c.source)?.source || undefined;
    const rows = await Promise.all(
      products.map((p, i) =>
        makeChemRow(
          {
            item_code: p.item_code,
            item_name: p.item_name,
            stock_uom: p.stock_uom,
            uoms: p.uoms,
            item_group: p.item_group,
            is_fertilizer: false,
          },
          p.default_rate,
          store,
          i,
        ),
      ),
    );
    setChemRows(rows);
  };

  /** `overridesArg` is passed by the override dialog, whose state update
   *  would not yet be visible to this closure. */
  const submit = async (overridesArg?: OverrideInput[]) => {
    if (!greenhouse || !sprayDate || !sprayType || !scope || !bom || !kit || !classification) {
      pushToast(
        "err",
        "Fill in greenhouse, date, spray type, scope, kit, tank mix and classification.",
      );
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
      if (!c.rate || c.rate <= 0) {
        pushToast("err", `Set a rate > 0 for ${c.item_name || c.item_code}.`);
        return;
      }
      if (!c.stock_qty || c.stock_qty <= 0) {
        pushToast(
          "err",
          `Water volume not set — ${c.item_name || c.item_code} has no total qty.`,
        );
        return;
      }
      const limitErr = rateLimitError(c.item_code, c.rate, rateLimits);
      if (limitErr) {
        pushToast("err", `${c.item_name || c.item_code}: ${limitErr}`);
        return;
      }
      // Draft-aware re-check (Task 9): mirrors stockShortRows so a plan
      // that slipped past the visual guard (e.g. a reservation landed
      // between render and click) still can't submit over the real
      // available qty.
      const avail = rowAvailable(c);
      if (avail < c.stock_qty) {
        pushToast(
          "err",
          `${c.item_name || c.item_code}: ${c.source} has ${avail.toFixed(2)} available but needs ${c.stock_qty}.`,
        );
        return;
      }
    }
    if (batchMissingRows.length) {
      pushToast(
        "err",
        `Pick a batch for ${batchMissingRows.map((c) => c.item_name || c.item_code).join(", ")}.`,
      );
      return;
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

    const overrides = overridesArg ?? pendingOverrides;
    if (checkLoading) {
      pushToast("err", "The spray check is still running. Try again in a moment.");
      return;
    }
    if (gate.state === "blocked") {
      pushToast("err", gate.reason || "This mix is blocked by the spray check.");
      return;
    }
    if (gate.state === "override" && check?.can_override && !overrides) {
      setOverrideOpen(true);
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
      // Only ship the override when it differs from the auto-resolved
      // value — the server derives the same default otherwise, so sending
      // it back redundantly is noise.
      const ccTrim = costCenterOverride.trim();
      const ccOverride = ccTrim && ccTrim !== (derivedCostCenter || "") ? ccTrim : "";
      const draftPayload = {
        custom_greenhouse: greenhouse,
        custom_cost_center: ccOverride,
        custom_classification: classification,
        custom_preventive_reason: preventiveReason,
        custom_spray_type: sprayType,
        custom_scope: scope,
        custom_scope_details: customScopeDetails,
        custom_kit: kit,
        custom_spray_team: sprayTeam || null,
        custom_spray_plan_team_members: teamMembers.map((m) => ({
          employee: m.employee,
          role: m.role,
        })),
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
          batch_no: c.batch_no || null,
          application_rate: c.stock_qty,
        })),
        custom_scheduled_application_time: sprayDate || null,
        spray_rule_overrides: overrides ?? [],
        alert: curativeAlert || undefined,
      };
      const r = await createDraftSprayPlan(draftPayload as Parameters<typeof createDraftSprayPlan>[0]);
      const woName = r?.work_order;
      dismissToast(loaderId);
      pushToast(
        "ok",
        woName ? `${woName} is in your draft batch.` : "The plan is in your draft batch.",
        4000,
        "Submit the batch when you have added every plan for the day.",
      );
      for (const w of r?.warnings || []) {
        pushToast("warn", w, 8000);
      }
      if (r?.compliance?.status === "Awaiting Override") {
        pushToast("ok", "Saved. An SCP General Manager must override before approval.");
      }
      if (curativeAlert) {
        // Converted on the server; drop its badge without a reload.
        const done = curativeAlert;
        setBootstrap((b) =>
          b
            ? {
                ...b,
                alerts: Object.fromEntries(
                  Object.entries(b.alerts || {}).map(([w, list]) => [w, list.filter((x) => x.name !== done)]),
                ),
              }
            : b,
        );
        setCurativeAlert("");
      }
      // Full reset — operator explicitly asked for a clean slate after
      // every Add-to-batch so the next plan starts from scratch (incl.
      // farm/greenhouse). Anything tied to the previous greenhouse would
      // mislead the operator if it lingered.
      setGreenhouse("");
      // The plan form's own fields: Scheduled Application back to today 06:00, tank
      // mix, kit, team, classification, reason, water and chemicals cleared.
      form.reset();
      setSprayType("");
      setScope("");
      setSelectedVarieties(new Set());
      setBedNumbers("");
      setArea("");
      setTeamMembers([]);
      setSelectedTargets(new Set());
      setCostCenterOverride("");
      setCostCenterEditing(false);
      // Notify the draft batch panel (mounted below) to refresh
      window.dispatchEvent(new CustomEvent("spray-plan:draft-added"));
    } catch (e: any) {
      dismissToast(loaderId);
      // A refused alert link must not trap the user: save again as a plain plan.
      if (/Scouting alert/i.test(errorText(e))) setCurativeAlert("");
      pushError(e, "The spray plan could not be added to your batch.");
    } finally {
      setBusy(false);
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
      <PageHeader
        title="New Application Floor Plan"
        eyebrow="Diagnose · Prescribe · Submit for approval"
      >
        <a
          href="/scp_app#/historical"
          className="text-xs text-muted-foreground underline"
        >
          View past plans →
        </a>
      </PageHeader>

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
        {/* A refresh keeps this house's counts up; say it is fetching. */}
        <LoadProgress
          active={!!greenhouse && loading && !!diagnose}
          progress={diagnoseState.progress?.percent ?? null}
          label={diagnoseState.progress?.label}
        />
        {!!greenhouse && diagnoseState.error && !loading && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {diagnoseState.error}
          </p>
        )}

        {replanWo && (
          <div role="status" className="flex items-start justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <div>
              <p className="font-medium">Re-planning {replanWo} — check the details before submitting</p>
              {replanPending.length > 0 && (
                <p className="text-muted-foreground">{pendingNote(replanPending.length)}</p>
              )}
            </div>
            <button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-foreground" onClick={() => setReplanWo("")}>
              Dismiss
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1 min-w-56">
            <Label>Greenhouse</Label>
            {/* One searchable picker, farms as headers (place picker G2): it
                replaces the separate farm filter. Disabled, not hidden, until
                its options have loaded. */}
            <PlacePicker
              level="greenhouse"
              variant="field"
              farms={ghByFarm}
              crop={initialCrop}
              label="Greenhouse"
              value={{ farm: "", greenhouse: greenhouse || "" }}
              onChange={(p) => setGreenhouse(p.greenhouse)}
              disabled={!ghList.length && !greenhouse}
              houseExtra={(g) => {
                const badge = ghActionBadge(bootstrap?.alerts?.[g]);
                return badge ? (
                  <Badge
                    variant={badge === "Spray advised" ? "destructive" : "secondary"}
                    className="text-[0.6rem]"
                  >
                    {badge}
                  </Badge>
                ) : null;
              }}
            />
          </div>
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>Latest scouting</span>
            <span className="font-medium tabular-nums text-foreground">
              {diagSkeleton ? (
                <TextSkeleton width="6rem" />
              ) : (
                latestScoutingDate ||
                  (greenhouse ? "No entries in 60 days" : "—")
              )}
            </span>
          </div>
          {greenhouse && (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground min-w-[14rem]">
              <span className="flex items-center justify-between gap-2">
                <span>Cost Center</span>
                {effectiveCostCenter && (
                  <span
                    className={
                      "text-[0.6rem] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded " +
                      (isCostCenterCustom
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                        : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300")
                    }
                  >
                    {isCostCenterCustom ? "Custom" : "Auto"}
                  </span>
                )}
              </span>
              {costCenterEditing ? (
                <div className="flex items-center gap-1.5">
                  <input
                    list="cost-center-options"
                    className="h-7 flex-1 min-w-0 rounded-md border bg-background px-2 text-xs font-medium text-foreground tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--sd-accent)]/40"
                    value={costCenterOverride || derivedCostCenter || ""}
                    onChange={(e) => setCostCenterOverride(e.target.value)}
                    onBlur={() => setCostCenterEditing(false)}
                    placeholder="Type or pick a Cost Center…"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <datalist id="cost-center-options">
                    {costCenterOptions.map((c) => (
                      <option
                        key={c.name}
                        value={c.name}
                        label={[c.custom_farm, c.company]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    ))}
                  </datalist>
                  {isCostCenterCustom && (
                    <button
                      type="button"
                      onClick={() => {
                        setCostCenterOverride("");
                        setCostCenterEditing(false);
                      }}
                      className="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground border px-2 py-1 rounded transition-colors"
                      title="Revert to the auto-resolved Cost Center."
                    >
                      Reset
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCostCenterEditing(true)}
                  className={
                    "font-medium text-left text-xs hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--sd-accent)]/30 rounded px-0.5 " +
                    (effectiveCostCenter
                      ? "text-foreground"
                      : "text-destructive")
                  }
                  title={
                    effectiveCostCenter
                      ? isCostCenterCustom
                        ? "Custom override — click to edit, Reset to revert."
                        : "Auto-resolved. Click to edit if needed."
                      : "No matching Cost Center found — click to pick one."
                  }
                >
                  {effectiveCostCenter || "Not configured — click to set"}
                </button>
              )}
            </div>
          )}
          {greenhouse && (
            <div className="ml-auto text-xs text-muted-foreground tabular-nums">
              {diagSkeleton ? (
                <TextSkeleton width="9rem" />
              ) : (
                <>
                  {affectedZones} / {totalZones} zones · {coveragePct}%
                </>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="relative" aria-busy={diagSkeleton || undefined}>
            {greenhouse && !geometry && !zonesLoaded ? (
              // The heatmap's own box while the zone polygons are parsed.
              <div
                className="min-h-[640px] w-full animate-pulse rounded-md border bg-[var(--sd-bg-soft)]"
                aria-label="Loading the greenhouse map"
                data-skeleton="heatmap"
              />
            ) : greenhouse && geometry ? (
              <button
                type="button"
                onClick={() => setHeatmapModal(true)}
                className="block w-full text-left"
                title="Click for full-screen view"
              >
                <BedSvg
                  geometry={geometry}
                  markers={bedMarkers}
                  className="w-full h-auto min-h-[640px] max-h-[820px] hover:ring-2 hover:ring-[var(--sd-accent)]/30 transition-shadow rounded-md border bg-card p-2"
                />
                <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-md bg-card/90 backdrop-blur border px-2 py-1 text-[0.65rem] text-muted-foreground">
                  <Maximize2 className="h-3 w-3" />
                  Click for full view
                </span>
              </button>
            ) : greenhouse ? (
              <Card className="p-8 flex flex-col items-center justify-center text-center min-h-[640px]">
                <CardTitle className="text-sm">No zone map for {greenhouse}</CardTitle>
                <CardDescription className="mt-1">
                  This greenhouse has no zone polygons yet, so the heatmap cannot be drawn.
                </CardDescription>
              </Card>
            ) : (
              <Card className="p-8 flex flex-col items-center justify-center text-center min-h-[640px]">
                <CardTitle className="text-sm">No greenhouse selected</CardTitle>
                <CardDescription className="mt-1">
                  Pick a greenhouse to load the scouting heatmap.
                </CardDescription>
              </Card>
            )}
            {greenhouse && geometry && (
              <>
                <StageLegend markers={bedMarkers} className="mt-2 px-1" />
                <HeatRampLegend className="mt-1 px-1" />
              </>
            )}
          </div>

          <div className="flex flex-col gap-3 min-h-0">
            {weatherFarm ? <WeatherCard farm={weatherFarm} /> : null}

            <Card className="p-3 flex-1 flex flex-col">
              <CardHeader className="p-0 pb-2">
                <CardTitle className="text-sm">Filters</CardTitle>
                <CardDescription>
                  Pest / Stage / Section · click a chip to focus, "All" to clear.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                    Pest / Disease
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    <DiagChip
                      label="All"
                      active={diag.pest === ALL}
                      onClick={() => setDiag({ ...diag, pest: ALL })}
                    />
                    {diagSkeleton && <ChipsSkeleton />}
                    {filterOpts.pests.map((p) => (
                      <DiagChip
                        key={p}
                        label={p}
                        active={diag.pest === p}
                        onClick={() => setDiag({ ...diag, pest: p })}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                    Stage
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    <DiagChip
                      label="All stages"
                      active={diag.stage === ALL}
                      onClick={() => setDiag({ ...diag, stage: ALL })}
                    />
                    {diagSkeleton && <ChipsSkeleton n={3} />}
                    {stagesForPest.map((s) => (
                      <DiagChip
                        key={s}
                        label={s}
                        active={diag.stage === s}
                        onClick={() => setDiag({ ...diag, stage: s })}
                      />
                    ))}
                    {!stagesForPest.length && diag.pest !== ALL ? (
                      <span className="text-[0.7rem] text-muted-foreground italic">
                        No stages recorded for {diag.pest}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label className="text-[0.7rem] uppercase tracking-wide text-muted-foreground">
                    Plant Section
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    <DiagChip
                      label="All sections"
                      active={diag.section === ALL}
                      onClick={() => setDiag({ ...diag, section: ALL })}
                    />
                    {diagSkeleton && <ChipsSkeleton n={3} />}
                    {sectionsForPest.map((s) => (
                      <DiagChip
                        key={s}
                        label={s}
                        active={diag.section === s}
                        onClick={() => setDiag({ ...diag, section: s })}
                      />
                    ))}
                    {!sectionsForPest.length && diag.pest !== ALL ? (
                      <span className="text-[0.7rem] text-muted-foreground italic">
                        No sections recorded for {diag.pest}
                      </span>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-md border bg-[var(--sd-bg-soft)] p-2.5">
                  <div className="text-[0.7rem] uppercase tracking-wide text-muted-foreground mb-1">
                    Thresholds
                  </div>
                  <CurativeAlerts
                    alerts={(greenhouse && bootstrap?.alerts?.[greenhouse]) || []}
                    activeAlert={curativeAlert}
                    onCreate={startCurative}
                  />
                  <div className="text-[0.65rem] text-muted-foreground mt-1 tabular-nums">
                    {diagSkeleton ? <TextSkeleton width="3ch" /> : coveragePct}% of zones flagged
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
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
              Set the application details and pick the tank mix, then submit.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[35fr_65fr] gap-3">
          <SprayPlanForm
            state={form}
            kits={kitList}
            teamSlot={
              <SprayTeamEditor
                teams={bootstrap?.spray_teams || []}
                team={sprayTeam}
                onTeamChange={setSprayTeam}
                members={teamMembers}
                onMembersChange={setTeamMembers}
                crop={initialCrop}
                onDate={(sprayDate || "").slice(0, 10) || undefined}
              />
            }
            boms={bomList}
            bomEligibility={bomElig}
            bomDisabled={!selectedTargets.size}
            bomHint={
              !selectedTargets.size ? (
                <span className="text-[0.65rem] text-muted-foreground">Pick targets first.</span>
              ) : null
            }
            onTankMixCreated={async () => {
              // Refresh the bootstrap so the new tank mix is in the picker; the form
              // then selects it.
              const fresh = await fetchCreatorBootstrap(initialCrop);
              setBootstrap(fresh);
            }}
            targets={targetsArr}
            suggestedCodes={suggestedCodes}
            flagged={flaggedItems}
            renderInfo={(c) => (
              <>
                {(() => {
                  const info = productInfo[c.item_code];
                  if (!info) return null;
                  const hits = info.targets.filter((t) => targetsArr.includes(t));
                  if (!hits.length && !info.codes.length) return null;
                  return (
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {hits.map((t) => (
                        <Badge key={t} variant="outline" className="text-[0.6rem] px-1.5 py-0">
                          {t}
                        </Badge>
                      ))}
                      {info.codes.map((code) => (
                        <Badge
                          key={code}
                          variant="outline"
                          className="text-[0.6rem] px-1.5 py-0 text-muted-foreground"
                        >
                          {code}
                        </Badge>
                      ))}
                    </div>
                  );
                })()}
                <ActiveIngredients items={mixIngr[c.item_code]?.ingredients} />
              </>
            )}
            detailsSlot={
              <>
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
              </>
            }
            targetsSlot={
              <>
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
                          ? "No pests or diseases are linked to this crop yet — add them under Crop Scouted in Desk."
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
              </>
            }
            suggestionsSlot={
              <SuggestedProductsCard
                embedded
                collapsible
                targets={targetsArr}
                greenhouses={greenhouse ? [greenhouse] : []}
                sourceWarehouse={
                  mappedStores?.chemical_store ||
                  chemRows.find((c) => !c.is_fertilizer && c.source)?.source ||
                  ""
                }
                currentItems={mixItems}
                when={sprayDate}
                canAdd={!!bomDetails}
                onSuggested={setSuggestedCodes}
                onAddMix={(products) => void addMix(products)}
                onAdd={(p) =>
                  void addChemical(
                    {
                      item_code: p.item_code,
                      item_name: p.item_name,
                      stock_uom: p.stock_uom,
                      uoms: p.uoms,
                      item_group: p.item_group,
                      is_fertilizer: false,
                    },
                    p.default_rate,
                    mappedStores?.chemical_store ||
                      chemRows.find((c) => !c.is_fertilizer && c.source)?.source ||
                      undefined,
                  )
                }
              />
            }
            afterChemicals={
              <>
                {chemRows.length ? (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <Label>Chemical Stock</Label>
                      {stockShortRows.length ? (
                        <span className="text-[0.65rem] text-[var(--sd-data-red)] tabular-nums">
                          {stockShortRows.length} row{stockShortRows.length === 1 ? "" : "s"} short — Submit disabled
                        </span>
                      ) : null}
                    </div>
                    {(["chemical", "fertilizer"] as const).map((group) => {
                      const rows = chemRows.filter(
                        (c) => !!c.is_fertilizer === (group === "fertilizer"),
                      );
                      if (!rows.length) return null;
                      const whs =
                        group === "fertilizer"
                          ? bomDetails?.fertilizer_warehouses ?? []
                          : bomDetails?.chemical_warehouses ?? [];
                      // Store lock (Task 9): when the greenhouse's farm
                      // maps a store for this group, the source is fixed
                      // — no dropdown, and (since get_bom_details already
                      // restricted ``whs`` to just this store) a single
                      // stock column. Unmapped farms keep the picker.
                      const forcedStore =
                        group === "fertilizer"
                          ? mappedStores?.fertilizer_store || null
                          : mappedStores?.chemical_store || null;
                      return (
                        <div key={group} className="mb-3 last:mb-0 overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="text-[0.65rem] uppercase">
                                  {group === "fertilizer" ? "Fertilizer" : "Chemical"}
                                </TableHead>
                                {whs.map((w) => (
                                  <TableHead
                                    key={w}
                                    className="text-center text-[0.65rem] uppercase tabular-nums whitespace-nowrap"
                                    title={w}
                                  >
                                    {w.replace(/\s*-\s*[A-Z]{2,}\s*$/, "").split(/\s+/).slice(-1)[0]}
                                  </TableHead>
                                ))}
                                <TableHead className="text-[0.65rem] uppercase">Source</TableHead>
                                <TableHead className="text-right text-[0.65rem] uppercase">Total</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {rows.map((c) => {
                                const balances = c.balances || {};
                                const need = c.stock_qty || 0;
                                const isShort = stockShortById.has(c.rowId);
                                const warn = rowWarnById.get(c.rowId);
                                // Soft amber: source not picked yet, or
                                // picked source isn't from the greenhouse's
                                // farm. Tints the whole row so the operator
                                // can spot the row at a glance without
                                // hunting through the warehouse columns.
                                const rowClass =
                                  warn === "red"
                                    ? "bg-[var(--sd-data-red)]/5"
                                    : warn === "amber"
                                      ? "bg-amber-50 dark:bg-amber-950/30"
                                      : "";
                                const triggerClass =
                                  warn === "red"
                                    ? "h-7 text-xs min-w-40 border-[var(--sd-data-red)]"
                                    : warn === "amber"
                                      ? "h-7 text-xs min-w-40 border-amber-500"
                                      : "h-7 text-xs min-w-40";
                                // Locked (mapped-store) rows skip the
                                // farm-mismatch heuristic entirely — the
                                // mapped store is correct by definition,
                                // regardless of whether its name happens
                                // to contain the farm's name substring.
                                const sourceMismatch =
                                  !forcedStore &&
                                  !!c.source &&
                                  !warehouseMatchesFarm(c.source);
                                return (
                                  <TableRow key={c.rowId} className={rowClass}>
                                    <TableCell className="text-xs font-medium whitespace-nowrap">
                                      <div className="flex items-center gap-1.5">
                                        {warn === "amber" && (
                                          <span
                                            title={
                                              !c.source
                                                ? "Pick a source warehouse"
                                                : `Source isn't in ${greenhouseFarm}`
                                            }
                                            className="inline-flex"
                                          >
                                            <AlertTriangle className="h-3 w-3 text-amber-500" />
                                          </span>
                                        )}
                                        <span>{c.item_name || c.item_code}</span>
                                      </div>
                                      {sourceMismatch && (
                                        <div className="text-[0.6rem] text-amber-700 dark:text-amber-300 mt-0.5">
                                          Source not in {greenhouseFarm}
                                        </div>
                                      )}
                                      {!c.source && need > 0 && (
                                        <div className="text-[0.6rem] text-amber-700 dark:text-amber-300 mt-0.5">
                                          Pick a chemical store
                                        </div>
                                      )}
                                    </TableCell>
                                    {whs.map((w) => {
                                      const bal = Number(balances[w] || 0);
                                      const sufficient = need > 0 && bal >= need;
                                      const insufficient = need > 0 && bal < need;
                                      const cls = sufficient
                                        ? "text-[var(--sd-data-green)]"
                                        : insufficient
                                          ? "text-[var(--sd-data-red)]"
                                          : "text-muted-foreground";
                                      const picked = c.source === w;
                                      return (
                                        <TableCell
                                          key={w}
                                          className={`text-center text-xs tabular-nums ${cls} ${picked ? "bg-muted/60 font-semibold" : ""}`}
                                        >
                                          {bal.toFixed(2)}
                                          {picked && (
                                            <div className="text-[0.6rem] font-normal text-muted-foreground">
                                              {rowAvailable(c).toFixed(2)} avail
                                            </div>
                                          )}
                                        </TableCell>
                                      );
                                    })}
                                    <TableCell>
                                      {forcedStore ? (
                                        <span
                                          className="text-xs font-medium truncate block max-w-40"
                                          title={`${forcedStore} — locked to this greenhouse's farm-mapped store`}
                                        >
                                          {forcedStore}
                                        </span>
                                      ) : (
                                        <Select
                                          value={c.source || ""}
                                          onValueChange={(v) =>
                                            setSource(c.rowId || c.item_code, v)
                                          }
                                        >
                                          <SelectTrigger
                                            className={triggerClass}
                                          >
                                            <SelectValue placeholder="-- Select Source --" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {whs.map((w) => {
                                              const bal = Number(balances[w] || 0);
                                              return (
                                                <SelectItem key={w} value={w}>
                                                  <span className="truncate">{w}</span>{" "}
                                                  <span className="text-muted-foreground tabular-nums">
                                                    · {bal.toFixed(2)}
                                                  </span>
                                                </SelectItem>
                                              );
                                            })}
                                          </SelectContent>
                                        </Select>
                                      )}
                                    </TableCell>
                                    <TableCell
                                      className={
                                        isShort
                                          ? "text-right text-xs tabular-nums font-semibold text-[var(--sd-data-red)]"
                                          : "text-right text-xs tabular-nums font-semibold"
                                      }
                                    >
                                      {need > 0 ? need.toFixed(2) : "—"}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {chemRows.length ? (
                  <SprayCheckCard
                    result={check}
                    loading={checkLoading}
                    names={Object.fromEntries(chemRows.map((c) => [c.item_code, c.item_name || c.item_code]))}
                  />
                ) : null}
              </>
            }
            footer={
              <>
              {bomDetails && (
                <div className="flex items-center justify-end gap-3 pt-2 border-t">
                  {stockShortRows.length ? (
                    <span
                      className="text-xs text-[var(--sd-data-red)] tabular-nums max-w-md text-right"
                      title={stockShortRows
                        .map((s) =>
                          s.source
                            ? `${s.name}: ${s.source} has ${s.avail} but needs ${s.need}`
                            : `${s.name}: no source warehouse picked (needs ${s.need})`,
                        )
                        .join("\n")}
                    >
                      {stockShortRows.length} chemical
                      {stockShortRows.length === 1 ? " is" : "s are"} short on stock
                    </span>
                  ) : null}
                  {gate.state === "blocked" ? (
                    <span className="text-xs text-destructive max-w-md text-right whitespace-pre-line">
                      {gate.reason}
                    </span>
                  ) : null}
                  <Button
                    onClick={() => submit()}
                    disabled={
                      busy || !greenhouse || stockShortRows.length > 0 || batchMissingRows.length > 0 || gate.state === "blocked"
                    }
                    size="sm"
                    title={
                      gate.state === "blocked"
                        ? gate.reason
                        : stockShortRows.length
                        ? stockShortRows
                            .map((s) =>
                              s.source
                                ? `${s.name}: ${s.source} has ${s.avail} but needs ${s.need}`
                                : `${s.name}: pick a source warehouse`,
                            )
                            .join("\n")
                        : undefined
                    }
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {gate.state === "override"
                      ? check?.can_override
                        ? "Save — needs GM override"
                        : "Save as draft (awaiting override)"
                      : "Add to batch"}
                  </Button>
                </div>
              )}
              </>
            }
          />
        </div>

        {/* Draft batch sits below the two top blocks at full width so the
             operator sees the running list of drafts after they hit
             Add-to-batch, instead of in a narrow side rail that gets
             pushed off-screen on smaller monitors. */}
        <DraftBatchPanel onToast={pushToast} onDismiss={dismissToast} />
      </section>

      {/* Fullscreen heatmap modal */}
      <Dialog open={heatmapModal} onOpenChange={setHeatmapModal}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{greenhouse}</DialogTitle>
            <DialogDescription>
              {affectedZones} of {totalZones} zones · {coveragePct}% coverage
            </DialogDescription>
          </DialogHeader>
          {geometry ? (
            <>
              <BedSvg
                geometry={geometry}
                markers={bedMarkers}
                className="w-full h-auto min-h-[360px] [&_svg]:max-h-[520px] [&_svg]:w-full"
              />
              <StageLegend markers={bedMarkers} className="mt-2 px-1" />
            </>
          ) : (
            <div className="text-xs text-muted-foreground p-4">
              Zone geometry not available for this greenhouse.
            </div>
          )}
        </DialogContent>
      </Dialog>

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        violations={check?.violations ?? []}
        onConfirm={(o) => {
          setPendingOverrides(o);
          setOverrideOpen(false);
          void submit(o);
        }}
      />

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
              ? "This page is restricted to users with the 'SCP Spray Plan Creator' role. Ask a General Manager to grant you the role."
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
            You hold the 'SCP Spray Plan Creator' role but no farm has been assigned to you.
            Ask a General Manager to add you on the Spray Plan Access page.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

/** Pest / stage / section chips that have not arrived, at a chip's own size. */
function ChipsSkeleton({ n = 5 }: { n?: number }) {
  const widths = ["w-16", "w-24", "w-20", "w-14", "w-28"];
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <Bar key={i} className={`h-[22px] rounded-full ${widths[i % widths.length]}`} />
      ))}
    </>
  );
}

function DiagChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.7rem] transition-colors " +
        (active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-muted-foreground hover:bg-muted")
      }
    >
      <span className="font-medium">{label}</span>
    </button>
  );
}
