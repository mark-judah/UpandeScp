/**
 * IT monitor (#/it): every phone running the Scout app, what it is running, what
 * it is holding back, and what has gone wrong. Spec: docs/superpowers/specs/
 * 2026-11-12-scp-it-monitor.md. Not crop-scoped; visible to SCP IT, System
 * Manager and SCP General Manager.
 */
import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilterSelect } from "@/components/FilterSelect";
import { TogglePill } from "@/components/TogglePill";
import { ClearFiltersPill } from "@/components/ClearFiltersPill";
import { PlaceMultiPicker } from "@/components/PlaceMultiPicker";
import { EMPTY_PLACE_SET, encodeNames, isEmptyPlaceSet, type PlaceSet } from "@/lib/places";
import { SearchInput } from "@/components/SearchInput";
import { HeaderIconButton } from "@/components/header-controls";
import { LoadProgress } from "@/components/Loading";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { bootstrap } from "@/lib/frappe";
import {
  DEVICE_STATUSES, canSeeItMonitor, fetchDataFlow, fetchDevices, fetchIssues, fetchLogins, fetchOverview, filterDevices,
} from "@/lib/it-monitor-api";
import { OverviewTab } from "@/components/it-monitor/OverviewTab";
import { DevicesTab } from "@/components/it-monitor/DevicesTab";
import { DeviceDrawer } from "@/components/it-monitor/DeviceDrawer";
import { ErrorsTab } from "@/components/it-monitor/ErrorsTab";
import { LoginsTab } from "@/components/it-monitor/LoginsTab";
import { DataFlowTab } from "@/components/it-monitor/DataFlowTab";
import { ErrorLine, useLoad } from "@/components/it-monitor/parts";

type Tab = "overview" | "devices" | "errors" | "logins" | "dataflow";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "devices", label: "Devices" },
  { id: "errors", label: "Errors" },
  { id: "logins", label: "Logins" },
  { id: "dataflow", label: "Data flow" },
];
const PERIODS = ["1 day", "7 days", "14 days", "30 days"];
const periodDays = (p: string) => parseInt(p, 10) || 7;

export function ITMonitor() {
  const roles = bootstrap().roles || [];
  const allowed = canSeeItMonitor(roles);
  const [tab, setTab] = useState<Tab>("overview");
  const [period, setPeriod] = useState("7 days");
  const [place, setPlace] = useState<PlaceSet>(EMPTY_PLACE_SET);
  const [status, setStatus] = useState("");
  const [stuckOnly, setStuckOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const days = periodDays(period);
  // Farm-only page: every farm in the set travels as one name or a JSON list.
  const farm = encodeNames(place.farms);
  const { farms } = useCropFarms("");
  const farmNames = useMemo(() => Object.keys(farms).sort(), [farms]);

  // Each tab loads only once opened (and again when its own filters change); the
  // device list is also what the Overview tile "with stuck data" jumps into.
  const overview = useLoad(() => (allowed ? fetchOverview(days, farm) : Promise.resolve(null)), `ov:${days}:${farm}`);
  const devices = useLoad(
    () => (allowed && tab === "devices" ? fetchDevices({ farm, status, stuck_only: stuckOnly }) : Promise.resolve(null)),
    `dev:${tab === "devices"}:${farm}:${status}:${stuckOnly}`,
  );
  const issues = useLoad(() => (allowed && tab === "errors" ? fetchIssues(days) : Promise.resolve(null)), `is:${tab === "errors"}:${days}`);
  const logins = useLoad(() => (allowed && tab === "logins" ? fetchLogins(days, farm) : Promise.resolve(null)), `lg:${tab === "logins"}:${days}:${farm}`);
  const flow = useLoad(() => (allowed && tab === "dataflow" ? fetchDataFlow(days, farm) : Promise.resolve(null)), `df:${tab === "dataflow"}:${days}:${farm}`);

  const shown = useMemo(() => (devices.data ? filterDevices(devices.data, { search }) : null), [devices.data, search]);
  const filtersOn = !!(!isEmptyPlaceSet(place) || status || stuckOnly || search);
  const reload = () => {
    overview.reload();
    if (tab === "devices") devices.reload();
    if (tab === "errors") issues.reload();
    if (tab === "logins") logins.reload();
    if (tab === "dataflow") flow.reload();
  };
  const active = { overview, devices, errors: issues, logins, dataflow: flow }[tab];

  if (!allowed) {
    return (
      <div className="p-8 max-w-lg">
        <h2 className="text-base font-semibold">You don't have access to this page</h2>
        <p className="mt-2 text-sm text-muted-foreground">The IT monitor is for the SCP IT role, System Managers and the SCP General Manager.</p>
      </div>
    );
  }

  const latest = overview.data?.latest_app_version ?? null;
  const placeFilter = (
    <PlaceMultiPicker farms={farmNames} value={place} onChange={setPlace} remember={false} label="Farm" />
  );
  const periodFilter = <FilterSelect label="Period" value={period} onChange={(v) => setPeriod(v || "7 days")} options={PERIODS} />;

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader
        eyebrow="IT · Phones in the field"
        title="IT monitor"
        tab={tab}
        switcher={
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>{TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}</TabsList>
          </Tabs>
        }
        filters={[
          { key: "farm", tabs: ["overview", "devices", "logins", "dataflow"], node: placeFilter },
          { key: "period", tabs: ["overview", "errors", "logins", "dataflow"], node: periodFilter },
          {
            key: "status", tabs: ["devices"],
            node: <FilterSelect label="Status" value={status} onChange={setStatus} options={DEVICE_STATUSES} allLabel="Any status" />,
          },
          {
            key: "stuck", tabs: ["devices"],
            node: <TogglePill pressed={stuckOnly} onPressedChange={setStuckOnly}>Stuck only</TogglePill>,
          },
          {
            key: "search", tabs: ["devices"],
            node: <SearchInput size="md" className="w-56" value={search} onChange={setSearch} placeholder="Search user, device, version" />,
          },
        ]}
      >
        <ClearFiltersPill
          active={filtersOn && tab === "devices"}
          onClear={() => { setPlace(EMPTY_PLACE_SET); setStatus(""); setStuckOnly(false); setSearch(""); }}
        />
        <HeaderIconButton aria-label="Refresh" tooltip="Reload this tab" onClick={reload}><RefreshCw className="h-4 w-4" /></HeaderIconButton>
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress active={active.loading && !!active.data} />
        <ErrorLine error={active.error} />
        {tab === "overview" && (
          <OverviewTab
            data={overview.data}
            loading={overview.loading}
            onOpenErrors={() => setTab("errors")}
            onStuck={() => { setStuckOnly(true); setTab("devices"); }}
          />
        )}
        {tab === "devices" && (
          <DevicesTab rows={shown} loading={devices.loading} latest={latest} filtered={filtersOn} onOpen={setOpen} />
        )}
        {tab === "errors" && <ErrorsTab rows={issues.data} loading={issues.loading} days={days} />}
        {tab === "logins" && <LoginsTab rows={logins.data} loading={logins.loading} />}
        {tab === "dataflow" && <DataFlowTab data={flow.data} loading={flow.loading} />}
      </div>
      <DeviceDrawer installId={open} latest={latest} onClose={() => setOpen(null)} />
    </div>
  );
}
