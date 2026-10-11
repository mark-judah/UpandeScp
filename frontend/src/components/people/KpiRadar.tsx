/**
 * A person's measures on one shape, with the farm median as a dashed outline.
 * Every axis runs the same way (the caption says which). Ported in shape from
 * Livestock's KpiRadar; drawn by hand.
 */

export interface RadarAxis {
  key: string;
  label: string;
  /** 0–1; null when there is nothing to judge by */
  value: number | null;
  /** what the number actually is, for the list underneath */
  readout: string;
}

const SIZE = 230;
const C = SIZE / 2;
const R = 78;
const RINGS = 3;
const LABEL_PAD = 44;

export function point(i: number, count: number, radius: number, c = C) {
  const a = (i / count) * 2 * Math.PI - Math.PI / 2;
  return { x: c + radius * Math.cos(a), y: c + radius * Math.sin(a) };
}

export function KpiRadar({
  axes,
  benchmark,
  benchmarkLabel = "Farm median",
  label = "Performance",
}: {
  axes: RadarAxis[];
  /** 0–1 per axis, same order; drawn dashed */
  benchmark?: (number | null)[];
  benchmarkLabel?: string;
  label?: string;
}) {
  const n = axes.length;
  const known = axes.some((a) => a.value != null);
  const poly = (vals: (number | null)[]) =>
    vals
      .map((v, i) => {
        const p = point(i, n, R * Math.max(0, Math.min(1, v ?? 0)));
        return `${p.x},${p.y}`;
      })
      .join(" ");

  return (
    <div className="flex flex-col gap-4">
      <svg
        viewBox={`${-LABEL_PAD} 0 ${SIZE + LABEL_PAD * 2} ${SIZE}`}
        className="h-[200px] w-full"
        role="img"
        aria-label={label}
      >
        {Array.from({ length: RINGS }, (_, r) => (
          <polygon
            key={r}
            points={Array.from({ length: n }, (_, i) => {
              const p = point(i, n, (R * (r + 1)) / RINGS);
              return `${p.x},${p.y}`;
            }).join(" ")}
            fill="none"
            stroke="var(--sd-line-soft)"
            strokeWidth={1}
          />
        ))}
        {axes.map((_, i) => {
          const p = point(i, n, R);
          return <line key={i} x1={C} y1={C} x2={p.x} y2={p.y} stroke="var(--sd-line-soft)" strokeWidth={1} />;
        })}
        {benchmark && (
          <polygon
            points={poly(benchmark)}
            fill="none"
            stroke="var(--sd-muted)"
            strokeWidth={1.25}
            strokeDasharray="4 3"
            data-testid="radar-benchmark"
          />
        )}
        {known && (
          <polygon
            points={poly(axes.map((a) => a.value))}
            fill="var(--sd-ink)"
            fillOpacity={0.1}
            stroke="var(--sd-ink)"
            strokeWidth={1.75}
            strokeLinejoin="round"
          />
        )}
        {axes.map((a, i) => {
          if (a.value == null) return null;
          const p = point(i, n, R * Math.max(0, Math.min(1, a.value)));
          return <circle key={a.key} cx={p.x} cy={p.y} r={3} fill="var(--sd-ink)" />;
        })}
        {axes.map((a, i) => {
          const p = point(i, n, R + 21);
          return (
            <text
              key={a.key}
              x={p.x}
              y={p.y}
              textAnchor={p.x > C + 4 ? "start" : p.x < C - 4 ? "end" : "middle"}
              dominantBaseline="middle"
              className="fill-[var(--sd-quiet)] text-[9px] font-medium uppercase"
              style={{ letterSpacing: "0.1em" }}
            >
              {a.label}
            </text>
          );
        })}
      </svg>
      {benchmark && (
        <p className="flex items-center gap-2 text-[11px] text-[var(--sd-quiet)]">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="var(--sd-muted)" strokeWidth="1.25" strokeDasharray="4 3" />
          </svg>
          {benchmarkLabel}
        </p>
      )}
      <dl className="flex flex-col gap-1.5">
        {axes.map((a) => (
          <div key={a.key} className="flex items-baseline justify-between gap-3">
            <dt className="text-[12px] text-[var(--sd-muted)]">{a.label}</dt>
            <dd className="truncate text-right text-[12px] tabular-nums text-[var(--sd-ink)]">{a.readout}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function KpiRadarSkeleton() {
  return <div className="h-[200px] w-full animate-pulse rounded bg-[var(--sd-bg-soft)]" aria-hidden />;
}
