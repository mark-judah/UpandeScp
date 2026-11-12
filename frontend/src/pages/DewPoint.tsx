/**
 * Scouting ▸ Dew point: per greenhouse, how close the air sits to its dew point.
 * Air within a couple of degrees of dew point wets the leaves (downy mildew).
 * Readings come from the greenhouse sensors, paired per sensor and averaged into
 * 30-minute slots by the server (condensation.dew_point_series).
 */
import { useEffect, useMemo, useState } from "react";
import { EMPTY_PLACE_SET, placeSetParams, type PlaceSet } from "@/lib/places";
import { useCropFarms } from "@/hooks/use-crop-farms";
import { PlaceMultiPicker } from "@/components/PlaceMultiPicker";
import { DateRangePicker } from "@/components/DateRangePicker";
import { Bar, ChartSkeleton, KpiValueSkeleton, LoadProgress, firstLoad } from "@/components/Loading";
import { PageHeader } from "@/components/PageHeader";
import { HouseCard } from "@/components/dew-point/HouseCard";
import { DEFAULT_CROP } from "@/lib/scouting-api";
import { dewTiles, fetchDewPoint, MAX_RANGE_DAYS, type DewSeries } from "@/lib/dew-point-api";
import { parseYmd, ymd } from "@/lib/utils";

const DAY = 86_400_000;

function last48h() {
  const to = new Date();
  return { from: ymd(new Date(to.getTime() - 2 * DAY)), to: ymd(to) };
}

/** Keep a picked range within the server's cap, moving the start. */
function capRange(r: { from: string; to: string }) {
  const to = parseYmd(r.to);
  const from = parseYmd(r.from);
  if (to.getTime() - from.getTime() > (MAX_RANGE_DAYS - 1) * DAY) {
    return { from: ymd(new Date(to.getTime() - (MAX_RANGE_DAYS - 1) * DAY)), to: r.to };
  }
  return r;
}

export function DewPoint({ initialCrop }: { initialCrop?: string } = {}) {
  const crop = initialCrop ?? DEFAULT_CROP;
  const { farms, loading: farmsLoading } = useCropFarms(crop);
  const [places, setPlaces] = useState<PlaceSet>(EMPTY_PLACE_SET);
  const { farm, greenhouse } = useMemo(() => placeSetParams(places, farms), [places, farms]);
  // null = the rolling last 48 hours (the server's default); a pick is whole days.
  const [picked, setPicked] = useState<{ from: string; to: string } | null>(null);
  const shown = picked ?? last48h();

  const [data, setData] = useState<DewSeries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let off = false;
    setLoading(true);
    fetchDewPoint({
      farms: farm,
      greenhouses: greenhouse,
      from_dt: picked ? `${picked.from} 00:00:00` : undefined,
      to_dt: picked ? `${picked.to} 23:59:59` : undefined,
    })
      .then((d) => {
        if (off) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => !off && setError(e instanceof Error ? e.message : "Failed to load"))
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
  }, [farm, greenhouse, picked]);

  const first = firstLoad(loading, !!data);
  const tiles = data ? dewTiles(data.greenhouses) : null;
  const limit = data?.spread_limit ?? 2;

  return (
    <div className="flex min-h-svh w-full min-w-0 flex-col">
      <PageHeader eyebrow="Scouting · Greenhouse sensors" title="Dew point">
        <PlaceMultiPicker farms={farms} crop={crop} label="Places" value={places} onChange={setPlaces} disabled={farmsLoading} />
        <DateRangePicker
          label="Date range"
          value={shown}
          max={ymd(new Date())}
          onChange={(r) => setPicked(capRange(r))}
        />
      </PageHeader>
      <div className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <LoadProgress active={loading} progress={null} />
        {error ? <div className="text-xs text-[var(--sd-data-red)]">Failed to load: {error}</div> : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="dew-tiles">
          <Tile label="Greenhouses at risk now" hint={tiles ? `of ${tiles.total} with readings` : ""} loading={first}
            value={tiles ? String(tiles.atRiskNow) : "—"} alert={!!tiles && tiles.atRiskNow > 0} />
          <Tile label="Hours at risk" hint={`spread ≤ ${limit} °C, all houses`} loading={first}
            value={tiles ? tiles.hoursAtRisk.toFixed(1) : "—"} />
          <Tile label="Lowest spread" hint={tiles?.lowest ? tiles.lowest.label : "temperature − dew point"} loading={first}
            value={tiles?.lowest ? `${tiles.lowest.spread.toFixed(1)} °C` : "—"} />
        </div>

        {first ? (
          <div className="flex flex-col gap-4">
            <ChartSkeleton height={380} />
            <ChartSkeleton height={380} />
          </div>
        ) : data && !data.sensors_available ? (
          <Notice title="No sensor data on this site">
            The Upande Sensors app is not installed here, so there are no greenhouse readings to show.
          </Notice>
        ) : data && data.mapped_sensors === 0 ? (
          <Notice title="No sensors are placed on a greenhouse yet">
            Each sensor is placed on a greenhouse by its GPS position and recorded on <b>Sensor Greenhouse Map</b>. A
            General Manager can re-run the placement (Remap sensors) or set a sensor's greenhouse by hand there. A
            sensor with no GPS fix has to be set by hand. Sensors in the cold room are left out.
          </Notice>
        ) : data && data.greenhouses.length === 0 ? (
          <Notice title="No greenhouses to show">None of the chosen places has a sensor placed on it.</Notice>
        ) : (
          data?.greenhouses.map((h) => (
            <HouseCard key={h.greenhouse} house={h} limit={limit} slotMinutes={data.slot_minutes} />
          ))
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, hint, loading, alert }: { label: string; value: string; hint?: string; loading: boolean; alert?: boolean }) {
  return (
    <div className="rounded-xl bg-card p-3 shadow-[var(--sd-shadow-1)]">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--sd-quiet)]">{label}</div>
      {loading ? (
        <KpiValueSkeleton className="mt-1" />
      ) : (
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${alert ? "text-[var(--sd-data-red)]" : ""}`}>{value}</div>
      )}
      {loading ? <Bar className="mt-1.5 h-3 w-28" /> : <div className="mt-0.5 text-xs text-[var(--sd-quiet)]">{hint}</div>}
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed bg-card px-6 py-10 text-center">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mx-auto mt-1 max-w-lg text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
