/**
 * Reports ▸ Coverage — the scouting data-quality view (personnel spec P2).
 * The same aggregate (`dashboard_aggregates.quality`) and the same component
 * (`DataQualityTab`) the Dashboard's "Data quality" tab used, unchanged, with
 * its own farm and date filters; this is now its one home.
 */
import { useState } from "react";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { useDashboardAggregate } from "@/hooks/use-dashboard-aggregate";
import { PlacePicker } from "@/components/PlacePicker";
import { DateRangePicker } from "@/components/DateRangePicker";
import { LoadProgress } from "@/components/Loading";
import { PageHeader } from "@/components/PageHeader";
import { DataQualityTab } from "@/pages/dashboard/DataQualityTab";
import type { QualityPayload } from "@/pages/dashboard/quality-types";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { ymd } from "@/lib/utils";

function lastThirtyDays() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(to.getDate() - 30);
  return { from: ymd(from), to: ymd(to) };
}

export function Coverage({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const { farms, loading: farmsLoading } = useCropFarms(crop);
  const [farm, setFarm] = useState(""); // "" → all farms
  const [{ from, to }, setRange] = useState(lastThirtyDays);

  const quality = useDashboardAggregate<QualityPayload>(
    "quality",
    { from_date: from, to_date: to, crop, farm, greenhouse: "" },
    true,
  );

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Reports · Scouting data quality" title="Coverage">
          <PlacePicker
            level="farm"
            farms={Object.keys(farms).sort()}
            crop={crop}
            label="Coverage farm"
            value={{ farm, greenhouse: "" }}
            onChange={(p) => setFarm(p.farm)}
            disabled={farmsLoading}
          />
          <DateRangePicker label="Date range" value={{ from, to }} onChange={setRange} />
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        {/* Inline under the filters, not a full-screen overlay: the tiles and
            tables stand (skeletons on the first load, old figures on a refresh). */}
        <LoadProgress
          active={quality.loading}
          progress={quality.progress?.percent ?? null}
          label={quality.progress?.label}
        />
        {quality.error ? (
          <div className="text-xs text-[var(--sd-data-red)]">Failed to load: {quality.error}</div>
        ) : null}
        {/* A failed first load shows the error above, not tiles pulsing forever. */}
        {quality.data || !quality.error ? <DataQualityTab data={quality.data} /> : null}
      </div>
    </div>
  );
}
