/**
 * Scouting KPIs — the Dashboard's Data quality view with its own farm and date
 * filters, so a manager can read the scouts' numbers next to the spray teams.
 * Same aggregate (`dashboard_aggregates.quality`), same component.
 */
import { useState } from "react";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { HEADER_PILL } from "@/components/header-controls";
import { DatePicker } from "@/components/DatePicker";
import { LoadingOverlay } from "@/components/LoadingOverlay";
import { DataQualityTab } from "@/pages/dashboard/DataQualityTab";
import type { QualityPayload } from "@/pages/dashboard/quality-types";
import { ymd } from "@/lib/utils";

const ALL = "__all__";

function lastThirtyDays() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 30);
  return { from: ymd(from), to: ymd(to) };
}

export function ScoutingKpisTab({ crop, active }: { crop: string; active: boolean }) {
  const { farms } = useCropFarms(crop);
  const [farm, setFarm] = useState<string>(ALL);
  const [{ from, to }, setRange] = useState(lastThirtyDays);

  const quality = useDashboardAggregate<QualityPayload>(
    "quality",
    { from_date: from, to_date: to, crop, farm: farm === ALL ? "" : farm, greenhouse: "" },
    active,
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select value={farm} onValueChange={setFarm}>
          <SelectTrigger aria-label="KPI farm" className={HEADER_PILL}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Farms</SelectItem>
            {Object.keys(farms).sort().map((f) => (
              <SelectItem key={f} value={f}>{f}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DatePicker value={from} onChange={(v) => setRange({ from: v, to })} />
        <DatePicker value={to} onChange={(v) => setRange({ from, to: v })} />
      </div>
      {quality.error ? (
        <div className="text-xs text-[var(--sd-data-red)]">Failed to load: {quality.error}</div>
      ) : null}
      <div className="relative">
        <DataQualityTab data={quality.data} />
        {quality.loading && (
          <LoadingOverlay
            open
            progress={quality.progress?.percent ?? null}
            label={quality.progress?.label}
          />
        )}
      </div>
    </div>
  );
}
