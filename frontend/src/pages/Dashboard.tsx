import { useEffect, useMemo, useState } from "react";
import {
  LayoutGrid,
  Bug,
  Hexagon,
  Crosshair,
  Sparkles,
  FileText,
  RefreshCw,
} from "lucide-react";
import { useScouting } from "@/hooks/use-scouting";
import {
  fetchCrops,
  fetchFarmsAndWarehouses,
  fetchScoutLookup,
  fetchZonesByGreenhouse,
  DEFAULT_CROP,
} from "@/lib/scouting-api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { DatePicker } from "@/components/DatePicker";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { OverviewTab } from "./dashboard/OverviewTab";
import { PestsTab } from "./dashboard/PestsTab";
import { DiseasesTab } from "./dashboard/DiseasesTab";
import { TrapsTab } from "./dashboard/TrapsTab";
import { FcmTab } from "./dashboard/FcmTab";
import { ymd } from "@/lib/utils";

const ALL_FARMS = "__all__";
const ALL_GH = "__all__";

function defaultRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  return { from: ymd(from), to: ymd(today) };
}

export function Dashboard() {
  const [crop, setCrop] = useState<string>(DEFAULT_CROP);
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [greenhouse, setGreenhouse] = useState<string>(ALL_GH);
  const [{ from, to }, setRange] = useState(defaultRange);
  const [crops, setCrops] = useState<
    Array<{ name: string; crop_name: string; farms?: string[] }>
  >([{ name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }]);
  const [farms, setFarms] = useState<Record<string, string[]>>({});
  const [scoutLookup, setScoutLookup] = useState<Record<string, string>>({});
  const [zonesByGh, setZonesByGh] = useState<Record<string, number>>({});

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
    fetchFarmsAndWarehouses().then(setFarms);
    fetchScoutLookup().then(setScoutLookup);
    fetchZonesByGreenhouse().then(setZonesByGh);
  }, []);

  const farmList = useMemo(() => {
    const cropAllow = crops.find((c) => c.crop_name === crop)?.farms || [];
    const all = Object.keys(farms);
    if (!cropAllow.length) return all;
    const allowSet = new Set(cropAllow);
    return all.filter((f) => allowSet.has(f));
  }, [farms, crops, crop]);

  const greenhouseList = useMemo(() => {
    if (farm === ALL_FARMS) {
      return Array.from(
        new Set(farmList.flatMap((f) => farms[f] || [])),
      ).sort();
    }
    return (farms[farm] || []).slice().sort();
  }, [farm, farmList, farms]);

  // Scope precedence: explicit greenhouse > farm's greenhouses > undefined.
  // Picking "Karen Farm" + "All Greenhouses" used to fall through to the
  // unfiltered fetch because only `greenhouse` was ever passed downstream.
  const greenhouseScope = useMemo(() => {
    if (greenhouse !== ALL_GH) return [greenhouse];
    if (farm !== ALL_FARMS) return farms[farm] || [];
    return undefined;
  }, [farm, greenhouse, farms]);

  const { data, loading, progress, weeksLoaded, weeksTotal, error, reload } = useScouting({
    from,
    to,
    greenhouses: greenhouseScope,
    crop,
  });

  return (
    <div className="flex flex-col min-h-svh">
      <header className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-card/80 backdrop-blur px-4 py-3 md:px-6 md:py-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <div>
              <h1 className="text-base md:text-lg font-semibold leading-tight tracking-tight">
                Scouting Dashboard
              </h1>
              <p className="text-[0.7rem] uppercase tracking-wide text-muted-foreground font-medium">
                Pest · Disease · Trap Monitoring
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 min-w-32">
              <Label htmlFor="crop">Crop</Label>
              <Select value={crop} onValueChange={setCrop}>
                <SelectTrigger id="crop" className="h-9">
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

            <div className="flex flex-col gap-1 min-w-32">
              <Label htmlFor="farm">Farm</Label>
              <Select
                value={farm}
                onValueChange={(v) => {
                  setFarm(v);
                  setGreenhouse(ALL_GH);
                }}
              >
                <SelectTrigger id="farm" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_FARMS}>All Farms</SelectItem>
                  {farmList.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1 min-w-40">
              <Label htmlFor="gh">Greenhouse</Label>
              <Select
                value={greenhouse}
                onValueChange={setGreenhouse}
                disabled={!greenhouseList.length}
              >
                <SelectTrigger id="gh" className="h-9">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_GH}>All Greenhouses</SelectItem>
                  {greenhouseList.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
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

            <Button
              variant="outline"
              size="sm"
              onClick={() => reload()}
              className="h-9"
              title="Reload (clears cache)"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload
            </Button>

            <Button asChild variant="outline" size="sm" className="h-9">
              <a href="/scouting_reports" target="_self">
                <FileText className="h-3.5 w-3.5" />
                Reports
              </a>
            </Button>
          </div>
        </div>

        {error && (
          <div className="text-xs text-[var(--sd-data-red)]">
            Failed to load: {error}
          </div>
        )}
      </header>

      <div className="flex-1 px-4 py-4 md:px-6 md:py-6">
        <Tabs defaultValue="overview" className="flex flex-col gap-4">
          <TabsList className="self-start flex-wrap">
            <TabsTrigger value="overview">
              <LayoutGrid />
              Overview
            </TabsTrigger>
            <TabsTrigger value="pests">
              <Bug />
              Pests
            </TabsTrigger>
            <TabsTrigger value="diseases">
              <Hexagon />
              Diseases
            </TabsTrigger>
            <TabsTrigger value="traps">
              <Crosshair />
              Traps
            </TabsTrigger>
            <TabsTrigger value="fcm">
              <Sparkles />
              FCM &amp; Moths
            </TabsTrigger>
          </TabsList>

          {loading && !data ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : (
            <>
              <TabsContent value="overview" className="mt-0">
                <OverviewTab
                  data={data}
                  scoutLookup={scoutLookup}
                  fromDate={from}
                  toDate={to}
                />
              </TabsContent>
              <TabsContent value="pests" className="mt-0">
                <PestsTab data={data} zonesByGreenhouse={zonesByGh} />
              </TabsContent>
              <TabsContent value="diseases" className="mt-0">
                <DiseasesTab data={data} zonesByGreenhouse={zonesByGh} />
              </TabsContent>
              <TabsContent value="traps" className="mt-0">
                <TrapsTab data={data} />
              </TabsContent>
              <TabsContent value="fcm" className="mt-0">
                <FcmTab data={data} />
              </TabsContent>
            </>
          )}
        </Tabs>
      </div>
      <LoadingOverlay
        open={loading}
        progress={progress}
        weeksLoaded={weeksLoaded}
        weeksTotal={weeksTotal}
      />
    </div>
  );
}
