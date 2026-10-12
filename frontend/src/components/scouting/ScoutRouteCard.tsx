/**
 * The card a scout's route (or its initials badge) opens over the Rose
 * Scouting map. Same floating style as the trap map's reading card, but it
 * sits on the right: who walked it (Employee photo, initials as fallback),
 * where and when, how much of the house, and the beds covered.
 */
import { X } from "lucide-react";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { formatCapture } from "@/lib/capture-time";
import { cn } from "@/lib/utils";

export interface ScoutTrail {
  key: string;
  scoutId: string;
  name: string;
  image?: string;
  color: string;
  greenhouse: string;
  date: string;
  zonesCovered: number;
  zonesTotal: number;
  /** "HH:MM:SS" of the first / last check-in, when the entries carry one. */
  start: string;
  end: string;
  beds: string[];
}

/** "08:05:00" → minutes since midnight (NaN when absent). */
function minutes(t: string): number {
  const m = /^(\d{2}):(\d{2})/.exec(t || "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

export function durationText(start: string, end: string): string {
  const d = minutes(end) - minutes(start);
  if (!Number.isFinite(d) || d < 0) return "";
  const h = Math.floor(d / 60);
  return h ? `${h} h ${d % 60} min` : `${d} min`;
}

/** "Chepsito GH 11 - KR - Bed 3" → "3". */
export function bedLabel(bed: string): string {
  const m = /Bed\s+(.+)$/i.exec(bed);
  return m ? m[1] : bed;
}

/**
 * Compact bed list: a count plus ranges, "33 beds · 212–256, 480–492".
 * Runs of consecutive numbers collapse, and so do step-2 runs (212, 214,
 * 216 → 212–216) since scouts often walk every other bed. Names without a bed
 * number are listed as they are, after the ranges.
 */
export function bedRanges(beds: string[]): string {
  if (!beds.length) return "";
  const nums: number[] = [];
  const other: string[] = [];
  for (const b of beds) {
    const m = /Bed\s+(\d+)\s*$/i.exec(b);
    if (m) nums.push(Number(m[1]));
    else if (!other.includes(b)) other.push(b);
  }
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    const d = sorted[i + 1] - sorted[i];
    let j = i;
    if (d === 1 || d === 2) while (j + 1 < sorted.length && sorted[j + 1] - sorted[j] === d) j++;
    if (j - i >= 2) {
      parts.push(`${sorted[i]}–${sorted[j]}`);
      i = j + 1;
    } else {
      parts.push(String(sorted[i]));
      i += 1;
    }
  }
  const count = sorted.length + other.length;
  return `${count} bed${count === 1 ? "" : "s"} · ${[...parts, ...other].join(", ")}`;
}

export function ScoutRouteCard({
  trail,
  onClose,
  className,
}: {
  trail: ScoutTrail;
  onClose: () => void;
  className?: string;
}) {
  const hhmm = (t: string) => t.slice(0, 5);
  const duration = durationText(trail.start, trail.end);
  const times = trail.start
    ? `${hhmm(trail.start)}${trail.end && trail.end !== trail.start ? ` – ${hhmm(trail.end)}` : ""}`
    : "—";
  const pct = trail.zonesTotal ? Math.round((trail.zonesCovered / trail.zonesTotal) * 100) : 0;

  return (
    <div
      role="dialog"
      aria-label={`Route of ${trail.name}`}
      data-testid="scout-route-card"
      className={cn(
        "w-[min(320px,calc(100%-2rem))] rounded-2xl border bg-card/95 p-4 shadow-[var(--sd-shadow-2,0_8px_24px_rgba(0,0,0,0.18))] backdrop-blur",
        "scp-card-in",
        className,
      )}
    >
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">Scout route</div>
          <div className="truncate text-sm font-semibold">{trail.greenhouse || "—"}</div>
        </div>
        <button
          type="button"
          aria-label="Close route card"
          onClick={onClose}
          className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <PersonAvatar id={trail.scoutId} name={trail.name} image={trail.image} size={56} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" data-testid="scout-card-name">{trail.name}</div>
          <div className="text-xs tabular-nums text-muted-foreground">{formatCapture(trail.date)}</div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: trail.color }} />
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold leading-none tabular-nums" data-testid="scout-card-zones">
            {trail.zonesCovered}
            <span className="text-sm font-normal text-muted-foreground">/{trail.zonesTotal || "?"}</span>
          </div>
          <div className="mt-1 text-[0.7rem] text-muted-foreground">zones</div>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t pt-3 text-[0.72rem]">
        <dt className="text-muted-foreground">Time</dt>
        <dd className="min-w-0 truncate text-right tabular-nums">{times}</dd>
        {duration ? (
          <>
            <dt className="text-muted-foreground">Duration</dt>
            <dd className="text-right tabular-nums">{duration}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Beds</dt>
        <dd className="min-w-0 break-words text-right tabular-nums line-clamp-2" title={trail.beds.map(bedLabel).join(", ")}>
          {trail.beds.length ? bedRanges(trail.beds) : "—"}
        </dd>
      </dl>
    </div>
  );
}
