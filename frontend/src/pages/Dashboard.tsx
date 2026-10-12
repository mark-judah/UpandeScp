import { useEffect, useState } from "react";
import { FileText, Gauge, RefreshCw } from "lucide-react";
import {
  fetchScoutLookup, fetchZonesByGreenhouse, DEFAULT_CROP,
} from "@/lib/scouting-api";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlacePicker } from "@/components/PlacePicker";
import { HeaderIconButton } from "@/components/header-controls";
import { DatePicker } from "@/components/DatePicker";
import { OverviewTab }  from "./dashboard/OverviewTab";
import { PestsTab }     from "./dashboard/PestsTab";
import { DiseasesTab }  from "./dashboard/DiseasesTab";
import { TrapsTab }     from "./dashboard/TrapsTab";
import { FcmTab }       from "./dashboard/FcmTab";
import { LoadProgress, firstLoad } from "@/components/Loading";
import { GalleryScopeProvider } from "@/components/gallery/ObservationGallery";
import { ymd } from "@/lib/utils";
import type { OverviewPayload } from "./dashboard/overview-types";
import type { PestsPayload, DiseasesPayload } from "./dashboard/pests-diseases-types";
import type { TrapsPayload } from "./dashboard/traps-types";
import type { FcmPayload } from "./dashboard/fcm-types";
import { cropSlug, routeHash } from "@/lib/router";


function defaultRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 30);
  return { from: ymd(from), to: ymd(today) };
}

type TabId = "overview" | "pests" | "diseases" | "traps" | "fcm";

export function Dashboard({ initialCrop }: { initialCrop?: string } = {}) {
  // The crop is the route's (spec D1); the page carries no crop picker.
  const crop = initialCrop ?? DEFAULT_CROP;
  // "" is "all" at each level (the place picker's value).
  const [farm, setFarm] = useState("");
  const [greenhouse, setGreenhouse] = useState("");
  const [{ from, to }, setRange] = useState(defaultRange);
  const { farms, loading: farmsLoading } = useCropFarms(crop);
  const [scoutLookup, setScoutLookup] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchScoutLookup().then(setScoutLookup);
    void fetchZonesByGreenhouse();
  }, []);

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
    crop,
    farm,
    greenhouse,
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

  // First load = no payload yet (and no error): the tab draws its cards with
  // skeletons inside. A refresh keeps the old payload on screen and only shows
  // the inline progress bar. "Not yet fetched" counts as loading too, so a tab
  // opened for the first time never flashes its empty-state wording.
  const firstOf = (h: { data: unknown; loading: boolean; error: string | null }) =>
    firstLoad(h.loading || (!h.data && !h.error), !!h.data);

  return (
    <div className="flex flex-col min-h-svh">
      {/* === Filter bar (same as before) === */}
      {/* Reference: no header bar — the page-head is text on the same paper
          background as the rest of the workspace (transparent, not sticky). */}
      <header className="flex flex-col gap-4 bg-transparent px-4 pt-5 pb-2 md:px-6 md:pt-6 md:pb-3">
        {/* Reference `.pagehead`: uppercase eyebrow with a leading rule, then
            a large editorial title. The switcher + filters live below on one
            row (not in the header). */}
        <div className="min-w-0">
          <div className="mb-2.5 flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sd-quiet)]">
            <span className="h-px w-[18px] bg-[var(--sd-text)]" />
            Pest · Disease · Trap Monitoring
          </div>
          <h1 className="text-[32px] md:text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] text-foreground">
            Scouting Dashboard
          </h1>
        </div>
      </header>

      <div className="flex-1 px-4 py-4 md:px-6 md:py-6">
        <GalleryScopeProvider scope={base}>
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)} className="flex flex-col gap-4">
          {/* Switcher + filters on one row. Switcher = reference `.pillgroup`
              (native TabsList); filters = pill dropdowns + icon tools. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="pests">Pests</TabsTrigger>
                <TabsTrigger value="diseases">Diseases</TabsTrigger>
                <TabsTrigger value="traps">Traps</TabsTrigger>
                <TabsTrigger value="fcm">FCM &amp; Moths</TabsTrigger>
              </TabsList>
              {/* Data quality lives under Reports ▸ Coverage now (personnel spec P2). */}
              <a
                href={routeHash({ crop: cropSlug(crop), view: "coverage" })}
                className="inline-flex items-center gap-1.5 rounded-[var(--sd-radius-pill)] px-3 py-1.5 text-[12.5px] text-[var(--sd-muted)] transition-colors hover:bg-[var(--sd-bg-soft)] hover:text-[var(--sd-ink)]"
              >
                <Gauge className="h-3.5 w-3.5" />
                Coverage
              </a>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <PlacePicker
                farms={farms}
                crop={crop}
                value={{ farm, greenhouse }}
                onChange={(p) => {
                  setFarm(p.farm);
                  setGreenhouse(p.greenhouse);
                }}
                disabled={farmsLoading}
              />

              <DatePicker
                value={from}
                onChange={(v) => setRange({ from: v, to })}
              />
              <DatePicker
                value={to}
                onChange={(v) => setRange({ from, to: v })}
              />

              <HeaderIconButton
                onClick={reloadActive}
                title="Reload (force cache refresh)"
              >
                <RefreshCw className="h-4 w-4" />
              </HeaderIconButton>

              <HeaderIconButton asChild title="Reports">
                <a href="/scouting_reports" target="_self">
                  <FileText className="h-4 w-4" />
                </a>
              </HeaderIconButton>
            </div>
          </div>

          {(() => {
            const active = ({ overview, pests, diseases, traps, fcm } as const)[
              tab
            ];
            return (
              <>
                {/* Was a full-screen overlay; now inline under the tabs so the
                    frame and any old data stay visible (skeleton spec K4). */}
                <LoadProgress
                  active={active.loading}
                  progress={active.progress?.percent ?? null}
                  label={active.progress?.label}
                />
                {active.error ? (
                  <div className="text-xs text-[var(--sd-data-red)]">
                    Failed to load: {active.error}
                  </div>
                ) : null}
              </>
            );
          })()}

          <TabsContent value="overview" className="mt-0">
            <OverviewTab
              data={overview.data}
              scoutLookup={scoutLookup}
              fromDate={from}
              toDate={to}
              crop={base.crop}
              farm={base.farm}
              greenhouse={base.greenhouse}
              loading={firstOf(overview)}
            />
          </TabsContent>
          <TabsContent value="pests" className="mt-0">
            <PestsTab
              data={pests.data}
              pestName={pestFilters.observation}
              section={pestFilters.section}
              stage={pestFilters.stage}
              onFiltersChange={setPestFilters}
              loading={firstOf(pests)}
            />
          </TabsContent>
          <TabsContent value="diseases" className="mt-0">
            <DiseasesTab
              data={diseases.data}
              diseaseName={diseaseFilters.observation}
              section={diseaseFilters.section}
              stage={diseaseFilters.stage}
              onFiltersChange={setDiseaseFilters}
              loading={firstOf(diseases)}
            />
          </TabsContent>
          <TabsContent value="traps" className="mt-0">
            <TrapsTab data={traps.data} loading={firstOf(traps)} />
          </TabsContent>
          <TabsContent value="fcm" className="mt-0">
            <FcmTab data={fcm.data} loading={firstOf(fcm)} />
          </TabsContent>
        </Tabs>
        </GalleryScopeProvider>
      </div>
    </div>
  );
}

