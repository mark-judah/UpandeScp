import { useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import PillNav from "@/components/PillNav";
import {
  fetchCrops, fetchFarmsAndWarehouses, fetchScoutLookup,
  fetchZonesByGreenhouse, DEFAULT_CROP,
} from "@/lib/scouting-api";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
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
            {!initialCrop && (
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
            )}

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
              onClick={reloadActive}
              className="h-9"
              title="Reload (force cache refresh)"
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

        {(() => {
          const active = ({ overview, pests, diseases, traps, fcm } as const)[tab];
          return active.error ? (
            <div className="text-xs text-[var(--sd-data-red)]">
              Failed to load: {active.error}
            </div>
          ) : null;
        })()}
      </header>

      <div className="flex-1 px-4 py-4 md:px-6 md:py-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex flex-col gap-4">
          <PillNav
            items={[
              { label: "Overview",   href: "#overview" },
              { label: "Pests",      href: "#pests" },
              { label: "Diseases",   href: "#diseases" },
              { label: "Traps",      href: "#traps" },
              { label: "FCM & Moths", href: "#fcm" },
            ]}
            activeHref={`#${tab}`}
            onSelect={(item) => setTab(item.href.slice(1) as TabId)}
            baseColor="var(--primary)"
            pillColor="var(--card)"
            pillTextColor="var(--foreground)"
            hoveredPillTextColor="var(--primary-foreground)"
            initialLoadAnimation={false}
            className="dashboard-pill-nav"
          />

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

