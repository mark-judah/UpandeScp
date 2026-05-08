import { useEffect, useMemo, useState } from "react";
import { ChevronDown, MapPin, Sparkles, RefreshCw } from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import {
  fetchCrops,
  fetchFarmsAndWarehouses,
  fetchZonesByGreenhouse,
  DEFAULT_CROP,
} from "@/lib/scouting-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/DatePicker";
import { LoadingStrip } from "@/components/LoadingStrip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Card } from "@/components/ui/card";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { ymd } from "@/lib/utils";
import { TristateTree } from "./trends/TristateTree";
import { ChartPanel } from "./trends/ChartPanel";
import {
  buildEntryIndex,
  buildObsTree,
  buildStationTree,
  gatherOptions,
  parseObs,
  parseSelection,
} from "./trends/aggregate";

function defaultRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  return { from: ymd(from), to: ymd(today) };
}

export function Trends() {
  const [crop, setCrop] = useState<string>(DEFAULT_CROP);
  const [{ from, to }, setRange] = useState(defaultRange);
  const [crops, setCrops] = useState<
    Array<{ name: string; crop_name: string; farms?: string[] }>
  >([{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }]);
  const [farmsByGh, setFarmsByGh] = useState<Record<string, string>>({});
  const [zonesByGh, setZonesByGh] = useState<Record<string, number>>({});
  const [stationChecks, setStationChecks] = useState<Set<string>>(new Set());
  const [obsChecks, setObsChecks] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchCrops().then((r) => {
      if (!r.length) return;
      const hasDefault = r.some((c) => c.crop_name === DEFAULT_CROP);
      setCrops(
        hasDefault
          ? r
          : [{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }, ...r],
      );
    });
    fetchFarmsAndWarehouses().then((farms) => {
      const ghToFarm: Record<string, string> = {};
      Object.entries(farms).forEach(([farm, ghs]) => {
        (ghs || []).forEach((g) => (ghToFarm[g] = farm));
      });
      setFarmsByGh(ghToFarm);
    });
    // Total zones per greenhouse — denominator for trend percentages.
    fetchZonesByGreenhouse().then(setZonesByGh);
  }, []);

  const { data, loading, error, reload } = useScouting({
    from,
    to,
    crop,
  });

  const opts = useMemo(
    () => (data ? gatherOptions(data.entries, farmsByGh) : null),
    [data, farmsByGh],
  );
  const stationTree = useMemo(
    () => (opts ? buildStationTree(opts.farmStations) : []),
    [opts],
  );
  const obsTree = useMemo(
    () => (opts ? buildObsTree(opts.pests, opts.diseases) : []),
    [opts],
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

  // Heavy index built once per (data, farm-map) pair and shared across every
  // chart panel — replaces the O(stations × days × entries) per-panel scan.
  const entryIndex = useMemo(
    () => buildEntryIndex(data?.entries || [], farmsByGh),
    [data?.entries, farmsByGh],
  );

  const stagesByObsId: Record<string, string[]> = useMemo(() => {
    if (!opts) return {};
    const out: Record<string, string[]> = {};
    Object.entries(opts.stagesByObs).forEach(([k, set]) => {
      out[k] = Array.from(set).sort();
    });
    return out;
  }, [opts]);

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Scouting Trends
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Across farms, stations, pests &amp; stages
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-32">
              <Label htmlFor="t-crop">Crop</Label>
              <Select value={crop} onValueChange={setCrop}>
                <SelectTrigger id="t-crop" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {crops.map((c) => (
                    <SelectItem key={c.crop_name} value={c.crop_name}>
                      {c.crop_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1">
              <Label>From</Label>
              <DatePicker
                value={from}
                onChange={(v) => setRange({ from: v, to })}
              />
            </div>

            <div className="flex flex-col gap-1">
              <Label>To</Label>
              <DatePicker
                value={to}
                onChange={(v) => setRange({ from, to: v })}
              />
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2">
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
                <Button variant="outline" size="sm" className="h-9 gap-2">
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

            <Button
              variant="default"
              size="sm"
              onClick={() => reload()}
              className="h-9"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>
          </div>
        </div>

        {error && (
          <div className="text-xs text-[var(--sd-data-red)]">
            Failed to load: {error}
          </div>
        )}
      </header>

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
        ) : (
          <>
            {observations.length === 0 ? (
              <ChartPanel
                index={entryIndex}
                selections={selections}
                obs={null}
                stages={[]}
                zonesByGreenhouse={zonesByGh}
              />
            ) : (
              observations.map((o) => {
                const key = `${o.kind}:${o.name}`;
                return (
                  <ChartPanel
                    key={key}
                    index={entryIndex}
                    selections={selections}
                    obs={o}
                    stages={stagesByObsId[key] || []}
                    zonesByGreenhouse={zonesByGh}
                  />
                );
              })
            )}
          </>
        )}
      </div>
      <LoadingStrip active={loading} />
    </div>
  );
}
