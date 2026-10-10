import { CHANGE_TONE, stationWord, type HouseClusters, type Patch, type PatchChange } from "@/lib/spread-api";

/** New / Grew / Shrank / Moved / Stable / Gone, as a tinted pill (no strips). */
export function ChangePill({ change }: { change: PatchChange }) {
  const tone = CHANGE_TONE[change];
  return (
    <span
      data-testid="change-pill"
      data-change={change}
      className="shrink-0 rounded-full border px-1.5 py-px text-[0.6rem] font-medium"
      style={{ color: tone, borderColor: tone, background: `color-mix(in srgb, ${tone} 10%, transparent)` }}
    >
      {change}
    </span>
  );
}

/** C5: the house's patches this week (largest first) and last week's that are gone. */
export function PatchesList({ data, onPinPatch }: { data: HouseClusters | null; onPinPatch?: (p: Patch) => void }) {
  if (!data || !data.week) return null;
  const word = stationWord(data.unit);
  const none = !data.clusters.length && !data.gone.length;
  return (
    <div data-testid="patches" className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-[0.7rem]">
        <span className="font-semibold uppercase tracking-wide text-muted-foreground">Patches</span>
        <span className="text-muted-foreground">
          {data.week}
          {data.prev_week ? ` vs ${data.prev_week}` : ""}
        </span>
      </div>
      {none ? (
        <span className="text-xs text-muted-foreground">No patch of 3 or more neighbouring {word}.</span>
      ) : null}
      {data.clusters.map((p) => (
        <div key={p.id} data-testid={`patch-${p.id}`} className="flex items-center gap-2 rounded bg-[var(--sd-bg-soft)] px-2 py-1 text-xs">
          <span className="shrink-0 font-semibold tabular-nums">
            {p.size} {word}
          </span>
          <span className="truncate text-muted-foreground">{p.label}</span>
          <ChangePill change={p.change} />
          {p.prev_size != null && p.change !== "Stable" ? (
            <span className="shrink-0 text-[0.65rem] tabular-nums text-muted-foreground">was {p.prev_size}</span>
          ) : null}
          {onPinPatch ? (
            <button
              type="button"
              onClick={() => onPinPatch(p)}
              className="ml-auto shrink-0 rounded border px-1.5 py-px text-[0.65rem] hover:bg-muted"
            >
              Pin this patch
            </button>
          ) : null}
        </div>
      ))}
      {data.gone.map((p) => (
        <div key={`gone-${p.id}`} data-testid={`gone-${p.id}`} className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground opacity-70">
          <span className="shrink-0 tabular-nums">
            {p.size} {word}
          </span>
          <span className="truncate">{p.label}</span>
          <ChangePill change="Gone" />
        </div>
      ))}
    </div>
  );
}
