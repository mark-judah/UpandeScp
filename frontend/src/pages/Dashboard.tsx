import { useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import {
  fetchCrops, fetchFarmsAndWarehouses, fetchScoutLookup,
  fetchZonesByGreenhouse, DEFAULT_CROP,
} from "@/lib/scouting-api";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { HEADER_PILL, HeaderIconButton } from "@/components/header-controls";
import { DatePicker } from "@/components/DatePicker";
import { OverviewTab }  from "./dashboard/OverviewTab";
import { PestsTab }     from "./dashboard/PestsTab";
import { DiseasesTab }  from "./dashboard/DiseasesTab";
import { TrapsTab }     from "./dashboard/TrapsTab";
import { FcmTab }       from "./dashboard/FcmTab";
import { ProgressOverlay } from "./dashboard/ProgressOverlay";
import { ymd } from "@/lib/utils";
import type { OverviewPayload } from "./dashboard/overview-types";
import type { PestsPayload, DiseasesPayload } from "./dashboard/pests-diseases-types";
import type { TrapsPayload } from "./dashboard/traps-types";
import type { FcmPayload } from "./dashboard/fcm-types";

const ALL_FARMS = "__all__";
const ALL_GH = "__all__";

function defaultRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  return { from: ymd(from), to: ymd(today) };
}

type TabId = "overview" | "pests" | "diseases" | "traps" | "fcm";

export function Dashboard({ initialCrop }: { initialCrop?: string } = {}) {
  const [crop, setCrop] = useState<string>(initialCrop ?? DEFAULT_CROP);
  const [farm, setFarm] = useState<string>(ALL_FARMS);
  const [greenhouse, setGreenhouse] = useState<string>(ALL_GH);
  const [{ from, to }, setRange] = useState(defaultRange);
  const [crops, setCrops] = useState<Array<{ name: string; crop_name: string;
                                              farms?: string[] }>>([
    { name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }
  ]);
  const [farms, setFarms] = useState<Record<string, string[]>>({});
  const [scoutLookup, setScoutLookup] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchCrops().then((r) => {
      if (!r.length) return;
      const hasDefault = r.some((c) => c.crop_name === DEFAULT_CROP);
      setCrops(hasDefault ? r : [
        { name: DEFAULT_CROP, crop_name: DEFAULT_CROP, farms: [] }, ...r,
      ]);
    });
    fetchFarmsAndWarehouses().then(setFarms);
    fetchScoutLookup().then(setScoutLookup);
    void fetchZonesByGreenhouse();
  }, []);

  const farmList = (() => {
    const cropAllow = crops.find((c) => c.crop_name === crop)?.farms || [];
    const all = Object.keys(farms);
    if (!cropAllow.length) return all;
    const allowSet = new Set(cropAllow);
    return all.filter((f) => allowSet.has(f));
  })();

  const greenhouseList = (() => {
    if (farm === ALL_FARMS)
      return Array.from(new Set(farmList.flatMap((f) => farms[f] || []))).sort();
    return (farms[farm] || []).slice().sort();
  })();

  const [tab, setTab] = useState<TabId>("overview");
  const [pestFilters, setPestFilters] = useState({
    observation: "", section: "", stage: "",
  });
  const [diseaseFilters, setDiseaseFilters] = useState({
    observation: "", section: "", stage: "",
  });

  const base = {
    from_date: from,
    to_date: to,
    crop: crop === DEFAULT_CROP ? "" : crop,
    farm: farm === ALL_FARMS ? "" : farm,
    greenhouse: greenhouse === ALL_GH ? "" : greenhouse,
  };

  const overview  = useDashboardAggregate<OverviewPayload>("overview",  base, tab === "overview");
  const pests     = useDashboardAggregate<PestsPayload>(   "pests",     { ...base, ...pestFilters },    tab === "pests");
  const diseases  = useDashboardAggregate<DiseasesPayload>("diseases",  { ...base, ...diseaseFilters }, tab === "diseases");
  const traps     = useDashboardAggregate<TrapsPayload>(   "traps",     base, tab === "traps");
  const fcm       = useDashboardAggregate<FcmPayload>(     "fcm",       base, tab === "fcm");

  const reloadActive = () => {
    const h = ({overview, pests, diseases, traps, fcm} as const)[tab];
    h.reload({ force: true });
  };

  return (
    <div className="flex flex-col min-h-svh">
      {/* === Filter bar (same as before) === */}
      <PageHeader
        eyebrow="Pest · Disease · Trap Monitoring"
        title={
          <span className="text-[32px] leading-[1.05] md:text-[44px]">
            Scouting Dashboard
          </span>
        }
      />

      <div className="flex-1 px-4 py-4 md:px-6 md:py-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex flex-col gap-4">
          {/* The switcher is the reference `.pillgroup` — a native TabsList,
              as kaitet has it. The animated PillNav this replaces carried its
              own colour props, hover choreography and an href-shaped API for
              something that is five tabs. */}
          {/* Switcher and filters share one row, as kaitet has them: the
              pillgroup on the left, the pill dropdowns and icon tools right. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="pests">Pests</TabsTrigger>
              <TabsTrigger value="diseases">Diseases</TabsTrigger>
              <TabsTrigger value="traps">Traps</TabsTrigger>
              <TabsTrigger value="fcm">FCM &amp; Moths</TabsTrigger>
            </TabsList>
          <div className="flex flex-wrap items-center gap-2">
            {!initialCrop && (
              <div className="flex items-center">
                <Select value={crop} onValueChange={setCrop}>
                  <SelectTrigger aria-label="Crop" className={HEADER_PILL}>
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
            )}

            <div className="flex items-center">
              <Select
                value={farm}
                onValueChange={(v) => {
                  setFarm(v);
                  setGreenhouse(ALL_GH);
                }}
              >
                <SelectTrigger aria-label="Farm" className={HEADER_PILL}>
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

            <div className="flex items-center">
              <Select
                value={greenhouse}
                onValueChange={setGreenhouse}
                disabled={!greenhouseList.length}
              >
                <SelectTrigger aria-label="Greenhouse" className={HEADER_PILL}>
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

            <div className="flex items-center">
              <DatePicker
                value={from}
                onChange={(v) => setRange({ from: v, to })}
              />
            </div>

            <div className="flex items-center">
              <DatePicker
                value={to}
                onChange={(v) => setRange({ from, to: v })}
              />
            </div>

            <HeaderIconButton
              onClick={reloadActive}
              aria-label="Reload"
              tooltip="Rebuild this dashboard from the server, ignoring the cached copy"
            >
              <RefreshCw className="h-4 w-4" />
            </HeaderIconButton>

            <HeaderIconButton
              asChild
              aria-label="Reports"
              tooltip="Open the scouting reports page"
            >
              <a href="/scouting_reports" target="_self">
                <FileText className="h-4 w-4" />
              </a>
            </HeaderIconButton>
          </div>

        {(() => {
          const active = ({ overview, pests, diseases, traps, fcm } as const)[tab];
          return active.error ? (
            <div className="text-xs text-[var(--sd-data-red)]">
              Failed to load: {active.error}
            </div>
          ) : null;
        })()}
          </div>

          <TabsContent value="overview" className="mt-0">
            <OverviewTab
              data={overview.data}
              scoutLookup={scoutLookup}
              fromDate={from}
              toDate={to}
              crop={base.crop}
            />
            {overview.loading && (
              <ProgressOverlay progress={overview.progress} />
            )}
          </TabsContent>
          <TabsContent value="pests" className="mt-0">
            <PestsTab
              data={pests.data}
              pestName={pestFilters.observation}
              section={pestFilters.section}
              stage={pestFilters.stage}
              onFiltersChange={setPestFilters}
            />
            {pests.loading && <ProgressOverlay progress={pests.progress} />}
          </TabsContent>
          <TabsContent value="diseases" className="mt-0">
            <DiseasesTab
              data={diseases.data}
              diseaseName={diseaseFilters.observation}
              section={diseaseFilters.section}
              stage={diseaseFilters.stage}
              onFiltersChange={setDiseaseFilters}
            />
            {diseases.loading && (
              <ProgressOverlay progress={diseases.progress} />
            )}
          </TabsContent>
          <TabsContent value="traps" className="mt-0">
            <TrapsTab data={traps.data} />
            {traps.loading && <ProgressOverlay progress={traps.progress} />}
          </TabsContent>
          <TabsContent value="fcm" className="mt-0">
            <FcmTab data={fcm.data} />
            {fcm.loading && <ProgressOverlay progress={fcm.progress} />}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

