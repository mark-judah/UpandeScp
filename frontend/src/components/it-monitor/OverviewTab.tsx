import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Bar as Skel, ChartSkeleton, KpiValueSkeleton, firstLoad } from "@/components/Loading";
import { cn } from "@/lib/utils";
import { overviewTiles, queueLabel, type ItOverview } from "@/lib/it-monitor-api";
import { Empty, NoDevicesYet, SectionCard } from "./parts";

const TILE_LABELS = ["Devices", "Active in 24 h", "Behind on version", "Dormant (7 d+)", "Low battery (<20%)", "Low storage (<1 GB)", "With stuck data"];

export function OverviewTab({
  data, loading, onOpenErrors, onStuck,
}: {
  data: ItOverview | null;
  loading: boolean;
  onOpenErrors: () => void;
  onStuck: () => void;
}) {
  const first = firstLoad(loading, !!data);
  const tiles = data ? overviewTiles(data) : null;
  const empty = !!data && data.devices.total === 0;
  const versions = (data?.versions ?? []).map((v) => ({
    label: v.runtime_version ? `${v.app_version} (rt ${v.runtime_version})` : v.app_version,
    devices: v.devices,
  }));
  const queues = Object.entries(data?.stuck_by_queue ?? {})
    .filter(([, n]) => n > 0)
    .map(([name, n]) => ({ label: queueLabel(name), devices: n }));
  const cfg: ChartConfig = { devices: { label: "Devices", color: "var(--chart-1)" } };
  const cfgStuck: ChartConfig = { devices: { label: "Devices with stuck data", color: "var(--sd-data-red)" } };

  return (
    <div className="flex flex-col gap-4">
      {empty ? <NoDevicesYet /> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {(tiles ?? TILE_LABELS.map((label) => ({ key: label, label, value: 0, warn: false, stuck: false }))).map((t) => (
          <button
            key={t.key}
            type="button"
            disabled={!t.stuck}
            onClick={t.stuck ? onStuck : undefined}
            className={cn("rounded-xl bg-card p-3 text-left shadow-[var(--sd-shadow-1)]", t.stuck && "cursor-pointer hover:shadow-[var(--sd-shadow-2)]")}
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--sd-quiet)]">{t.label}</div>
            {first ? (
              <KpiValueSkeleton className="mt-1" />
            ) : (
              <div className={cn("mt-1 text-2xl font-semibold tabular-nums", t.warn && "text-[var(--sd-data-amber)]", t.stuck && t.value > 0 && "text-[var(--sd-data-red)]")}>
                {t.value}
              </div>
            )}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          title="App versions in the field"
          hint={data?.latest_app_version ? `Latest: ${data.latest_app_version}` : "Latest version not known yet"}
        >
          {first ? (
            <ChartSkeleton height={220} />
          ) : versions.length === 0 ? (
            <Empty>No versions reported yet.</Empty>
          ) : (
            <ChartContainer config={cfg} className="aspect-auto h-[220px]">
              <BarChart data={versions} margin={{ left: 0, right: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} />
                <YAxis allowDecimals={false} width={28} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="devices" fill="var(--color-devices)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </SectionCard>

        <SectionCard title="Stuck data by queue" hint="Devices holding failed, refused, held or very old items">
          {first ? (
            <ChartSkeleton height={220} />
          ) : queues.length === 0 ? (
            <Empty>Nothing stuck on any phone.</Empty>
          ) : (
            <ChartContainer config={cfgStuck} className="aspect-auto h-[220px]">
              <BarChart data={queues} layout="vertical" margin={{ left: 8, right: 8 }}>
                <CartesianGrid horizontal={false} />
                <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="label" width={110} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="devices" fill="var(--color-devices)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartContainer>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Errors" hint="In the selected period">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          {[
            ["Events", data?.errors.events],
            ["Distinct issues", data?.errors.issues],
            ["Crashes", data?.errors.crashes],
            ["Logins today", data?.logins_today],
          ].map(([label, v]) => (
            <div key={label as string}>
              <div className="text-[11px] uppercase tracking-wider text-[var(--sd-quiet)]">{label}</div>
              {first ? <Skel className="mt-1 h-7 w-12" /> : <div className="text-xl font-semibold tabular-nums">{(v as number) ?? 0}</div>}
            </div>
          ))}
          <button type="button" onClick={onOpenErrors} className="ml-auto text-xs underline text-muted-foreground hover:text-foreground">
            Open the errors tab
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
