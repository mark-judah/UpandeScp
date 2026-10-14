import { pinValueLabel, type ScoutingPin } from "@/lib/spread-api";

type Pt = [number, number];

/** Split the weekly values into runs of consecutive scouted weeks: a null
 *  (thin or unscouted) week ends the run, so the line shows a gap there. */
export function sparkSegments(points: (number | null)[], W = 84, H = 22): Pt[][] {
  const step = points.length > 1 ? W / (points.length - 1) : 0;
  const out: Pt[][] = [];
  let run: Pt[] = [];
  points.forEach((v, i) => {
    if (v == null) {
      if (run.length) out.push(run);
      run = [];
    } else {
      run.push([i * step, H - (Math.max(0, Math.min(100, v)) / 100) * H]);
    }
  });
  if (run.length) out.push(run);
  return out;
}

/** 0–100 values left to right; a null (thin or unscouted) week is a gap. */
export function Sparkline({ points, testId }: { points: (number | null)[]; testId?: string }) {
  const W = 84;
  const H = 22;
  const segments = sparkSegments(points, W, H);
  const shown = segments.flat();
  return (
    <svg data-testid={testId} data-points={shown.length} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 overflow-visible" aria-hidden>
      {segments
        .filter((seg) => seg.length > 1)
        .map((seg, i) => (
          <polyline
            key={i}
            data-testid="spark-segment"
            points={seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
            fill="none"
            stroke="var(--sd-data-purple)"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        ))}
      {shown.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={1.6} fill="var(--sd-data-purple)" />
      ))}
    </svg>
  );
}

/** C7: the house's pins with their last scouted weeks. */
export function PinsPanel({ pins, onDelete }: { pins: ScoutingPin[]; onDelete?: (name: string) => void }) {
  return (
    <div data-testid="pins" className="flex flex-col gap-1">
      {pins.length ? (
        pins.map((p) => {
          const series = p.series ?? [];
          const last = series[series.length - 1];
          return (
            <div key={p.name} data-testid={`pin-${p.name}`} className="flex items-center gap-2 rounded bg-[var(--sd-bg-soft)] px-2 py-1 text-xs">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{p.title}</span>
                <span className="truncate text-[0.65rem] text-muted-foreground">
                  {p.kind} · {p.observation || "every pest and disease"}
                  {p.shared ? "" : " · private"}
                </span>
              </div>
              <Sparkline points={series.map((s) => s.value)} testId={`pin-sparkline-${p.name}`} />
              <span className="ml-auto shrink-0 tabular-nums" title={last ? `${last.infested} of ${last.scouted} stations · ${last.week}` : undefined}>
                {pinValueLabel(last)}
              </span>
              {p.may_edit && onDelete ? (
                <button
                  type="button"
                  onClick={() => onDelete(p.name)}
                  aria-label={`Delete pin ${p.title}`}
                  className="shrink-0 rounded border px-1.5 py-px text-[0.65rem] hover:bg-muted"
                >
                  Delete
                </button>
              ) : null}
            </div>
          );
        })
      ) : (
        <span className="text-xs text-muted-foreground">No pins on this house yet.</span>
      )}
    </div>
  );
}
