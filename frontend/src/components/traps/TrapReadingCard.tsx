/**
 * The card a trap click opens over the map (spec 2026-10-11 TM3): who recorded
 * the latest reading — Employee photo, name — when (date + time of capture),
 * the count and pest, and the trap's summary lines.
 *
 * The map already knows the latest reading from its scouting entries, so that
 * shows at once; the server (`get_latest_trap_reading`) fills in the scout's
 * name and photo.
 */
import { useEffect, useState, type ReactNode } from "react";
import { MapFloatingCard } from "@/components/maps/MapFloatingCard";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { formatCapture } from "@/lib/capture-time";
import { fetchLatestTrapReading, type TrapReading } from "@/lib/trap-reading-api";

/** What the map computed from its entries — shown before the server answers. */
export interface LocalReading {
  scout?: string;
  date?: string;
  time?: string;
  count?: number;
  pest?: string;
}

export function TrapReadingCard({
  trap,
  from,
  to,
  local,
  details,
  onClose,
  className,
}: {
  trap: string;
  from?: string;
  to?: string;
  local?: LocalReading;
  details?: Array<{ label: string; value: ReactNode }>;
  onClose: () => void;
  className?: string;
}) {
  const [reading, setReading] = useState<TrapReading | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReading(null);
    setFailed(false);
    fetchLatestTrapReading(trap, from, to)
      .then((r) => !cancelled && setReading(r))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [trap, from, to]);

  const server = reading?.entry ? reading : null;
  const scoutId = server?.scout || local?.scout || "";
  const scoutName = server?.scoutName || local?.scout || "";
  const date = server?.date || local?.date || "";
  const time = server?.time || local?.time || "";
  const count = server?.count ?? local?.count;
  const pest = server?.pest || local?.pest || "";
  const none = reading && !reading.entry && !local?.date;

  return (
    <MapFloatingCard
      eyebrow="Trap"
      title={trap}
      onClose={onClose}
      className={className}
      label={`Trap ${trap}`}
      closeLabel="Close trap card"
      testId="trap-reading-card"
    >
      {none ? (
        <p className="text-xs text-muted-foreground">No reading at this trap in the selected range.</p>
      ) : (
        <div className="flex items-center gap-3">
          {scoutId || scoutName ? (
            <PersonAvatar id={scoutId} name={scoutName} image={server?.image} size={56} />
          ) : (
            <span className="h-14 w-14 shrink-0 animate-pulse rounded-full bg-muted" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" data-testid="trap-card-scout">
              {scoutName || (failed ? "Unknown scout" : "Loading…")}
            </div>
            <div className="text-[0.7rem] text-muted-foreground">Latest reading</div>
            <div className="text-xs tabular-nums" data-testid="trap-card-time">
              {formatCapture(time ? `${date} ${time}` : date)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold leading-none tabular-nums" data-testid="trap-card-count">
              {count ?? "—"}
            </div>
            <div className="mt-1 max-w-[7rem] truncate text-[0.7rem] text-muted-foreground">{pest || "—"}</div>
          </div>
        </div>
      )}

      {details?.length ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-3 text-[0.72rem]">
          {details.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd className="min-w-0 truncate text-right tabular-nums">{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </MapFloatingCard>
  );
}