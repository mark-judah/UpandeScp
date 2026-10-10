import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, MapPin, Sparkles, RefreshCw, Gauge } from "lucide-react";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { getThresholds, type ThresholdsBundle } from "@/lib/thresholds-api";
import { thresholdMapFromBundle } from "@/lib/threshold-measure";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/DatePicker";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
import { ymd } from "@/lib/utils";
import { TristateTree } from "./trends/TristateTree";
import { ChartPanel } from "./trends/ChartPanel";
import {
  buildMatrixIndex,
  buildObsTree,
  buildStationTree,
  parseObs,
  parseSelection,
} from "./trends/aggregate";
import type { TrendsPayload } from "./trends/trends-types";
import type {
  ThresholdBand,
  ThresholdLookup,
} from "./trends/ChartPanel";

function defaultRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  return { from: ymd(from), to: ymd(today) };
}

export function Trends({ initialCrop }: { initialCrop?: string } = {}) {
  // The crop is the route's (spec D1); the page carries no crop picker.
  const crop = initialCrop ?? DEFAULT_CROP;
  const [{ from, to }, setRange] = useState(defaultRange);
  const [stationChecks, setStationChecks] = useState<Set<string>>(new Set());
  const [obsChecks, setObsChecks] = useState<Set<string>>(new Set());
  const [showThresholds, setShowThresholds] = useState(true);
  const [thresholdBundle, setThresholdBundle] =
    useState<ThresholdsBundle | null>(null);

  const { data, loading, error, progress, reload } =
    useDashboardAggregate<TrendsPayload>(
      "trends",
      {
        from_date: from,
        to_date: to,
        crop,
      },
      true,
    );

  const stationTree = useMemo(
    () => (data ? buildStationTree(data.options.farmStations) : []),
    [data],
  );
  const obsTree = useMemo(
    () =>
      data ? buildObsTree(data.options.pests, data.options.diseases) : [],
    [data],
  );

  const selections = useMemo(
    () =>
      Array.from(stationChecks)
        .map(parseSelection)
        .filter((s): s is NonNullable<typeof s> => !!s),
    [stationChecks],
  );
  const observations = useMemo(
    () =>
      Array.from(obsChecks)
        .map(parseObs)
        .filter((o): o is NonNullable<typeof o> => !!o),
    [obsChecks],
  );

  // Load the per-stage / aggregate thresholds for the chosen crop so the
  // ChartPanel can draw the Low / Mod / High reference lines. Pass the
  // literal crop name (NOT the empty-string convention the aggregate
  // endpoint uses for the default crop) — thresholds_api keys by the
  // Crop Scouted doc name and needs the real value.
  useEffect(() => {
    if (!crop) {
      setThresholdBundle(null);
      return;
    }
    let cancelled = false;
    getThresholds(crop)
      .then((b) => {
        if (!cancelled) setThresholdBundle(b);
      })
      .catch(() => {
        if (!cancelled) setThresholdBundle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [crop]);

  // Flat lookup keyed by `${kind}::${name}::${stage}` (stage "" = the row), each
  // band carrying its measure and unit. Unset and misordered bands are left out,
  // as the server leaves them out (thresholds spec §5).
  const thresholdMap = useMemo(() => thresholdMapFromBundle(thresholdBundle), [thresholdBundle]);

  const thresholdLookup: ThresholdLookup = useCallback(
    (kind, name, stage) => {
      const stageBand = thresholdMap.get(`${kind}::${name}::${stage}`);
      if (stageBand) return stageBand;
      return thresholdMap.get(`${kind}::${name}::`) || null;
    },
    [thresholdMap],
  );

  // Heavy index built once per payload — every ChartPanel reuses it.
  const matrixIndex = useMemo(
    () => (data ? buildMatrixIndex(data) : null),
    [data],
  );

  const stagesByObsId: Record<string, string[]> = data?.options.stagesByObs || {};

  return (
    <div className="flex flex-col min-h-svh">
      <PageHeader
        title="Scouting Trends"
        eyebrow={<>Across farms, stations, pests &amp; stages</>}
      >
        <DatePicker value={from} onChange={(v) => setRange({ from: v, to })} />
        <DatePicker value={to} onChange={(v) => setRange({ from, to: v })} />

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className={HEADER_PILL}>
              <MapPin className="h-3.5 w-3.5" />
              Farms
              <span className="text-muted-foreground tabular-nums">
                {selections.length || "—"}
              </span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <TristateTree
              nodes={stationTree}
              checked={stationChecks}
              onChange={setStationChecks}
              emptyHint="No farms in date range"
              searchPlaceholder="Search farms or greenhouses…"
            />
          </PopoverContent>
        </Popover>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className={HEADER_PILL}>
              <Sparkles className="h-3.5 w-3.5" />
              Observations
              <span className="text-muted-foreground tabular-nums">
                {observations.length || "—"}
              </span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <TristateTree
              nodes={obsTree}
              checked={obsChecks}
              onChange={setObsChecks}
              emptyHint="No observations in date range"
              searchPlaceholder="Search observations…"
            />
          </PopoverContent>
        </Popover>

        <HeaderIconButton
          active={showThresholds}
          onClick={() => setShowThresholds((v) => !v)}
          title={
            showThresholds
              ? "Hide threshold reference lines"
              : "Show threshold reference lines from Settings"
          }
        >
          <Gauge className="h-4 w-4" />
        </HeaderIconButton>

        <HeaderIconButton onClick={() => reload({ force: true })} title="Reload">
          <RefreshCw className="h-4 w-4" />
        </HeaderIconButton>
      </PageHeader>

      {error && (
        <div className="text-xs text-[var(--sd-data-red)]">
          Failed to load: {error}
        </div>
      )}

      <div className="flex-1 px-4 py-4 md:px-6 md:py-6 flex flex-col gap-4">
        {!selections.length ? (
          <Card className="p-12 flex flex-col items-center justify-center text-center gap-2">
            <div className="h-10 w-10 rounded-full bg-[var(--sd-pistachio)] flex items-center justify-center">
              <MapPin className="h-5 w-5 text-muted-foreground" />
            </div>
            <h2 className="text-base font-semibold">Pick stations to start</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Click a farm for an aggregate line, or click individual
              greenhouses to compare them. Add Observations to filter the
              series.
            </p>
          </Card>
        ) : data && matrixIndex ? (
          <>
            {observations.length === 0 ? (
              <ChartPanel
                payload={data}
                index={matrixIndex}
                selections={selections}
                obs={null}
                stages={[]}
                thresholdLookup={thresholdLookup}
                showThresholds={showThresholds}
              />
            ) : (
              observations.map((o) => {
                const key = `${o.kind}:${o.name}`;
                return (
                  <ChartPanel
                    key={key}
                    payload={data}
                    index={matrixIndex}
                    selections={selections}
                    obs={o}
                    stages={stagesByObsId[key] || []}
                    thresholdLookup={thresholdLookup}
                    showThresholds={showThresholds}
                  />
                );
              })
            )}
          </>
        ) : null}
      </div>
      <LoadingOverlay
        open={loading}
        progress={progress?.percent ?? null}
        label={progress?.label}
      />
    </div>
  );
}
