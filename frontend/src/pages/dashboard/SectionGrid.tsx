import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { SectionCell } from "@/lib/prevalence";

const ROWS = ["First third", "Middle third", "Last third"];
const COLS = ["Front", "Middle", "Back"];

/** The house as a 3 × 3 grid: rows are thirds of its beds (or orchard rows) in
 *  order, columns the front / middle / back of each bed. Each cell shows its
 *  prevalence; a cell with fewer than 3 stations scouted is greyed "not scouted"
 *  because it does not enter the adjusted figure. A hot spot (``hot``) is ringed
 *  all round: an outline, never a side strip. */
export function SectionGrid({
  sections,
  onPinSection,
}: {
  sections: SectionCell[];
  /** When given, each cell carries a "Pin" button for this section (spread spec C6). */
  onPinSection?: (row: number, col: number) => void;
}) {
  const at = new Map(sections.map((s) => [`${s.row}:${s.col}`, s]));
  const anyHot = sections.some((s) => s.hot);
  return (
    <div className="flex flex-col gap-1">
      <div
        data-testid="section-grid"
        className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] gap-1 text-[0.7rem]"
      >
        <span />
        {COLS.map((c) => (
          <span key={c} className="text-center text-[0.6rem] uppercase tracking-wide text-muted-foreground">
            {c}
          </span>
        ))}
        {ROWS.map((label, r) => (
          <Fragment key={label}>
            <span className="self-center whitespace-nowrap pr-2 text-muted-foreground">{label}</span>
            {COLS.map((_c, c) => {
              const s = at.get(`${r}:${c}`);
              const pct = s?.pct ?? null;
              const scouted = pct != null;
              const hot = !!s?.hot;
              return (
                <div
                  key={c}
                  data-testid={`section-${r}-${c}`}
                  data-scouted={scouted ? "true" : "false"}
                  data-hot={hot ? "true" : "false"}
                  title={s ? `${s.infested} of ${s.scouted} stations scouted${hot ? " · hot spot" : ""}` : "no stations"}
                  className={cn(
                    "rounded-md border px-2 py-2 text-center tabular-nums",
                    scouted ? "text-foreground" : "bg-[var(--sd-bg-soft)] text-muted-foreground opacity-60",
                    hot && "ring-2 ring-[var(--sd-data-purple)] ring-offset-1 ring-offset-[var(--sd-card)] font-semibold",
                  )}
                  style={
                    scouted
                      ? { background: `color-mix(in srgb, var(--sd-data-red) ${Math.min(60, Math.round(pct))}%, var(--sd-card))` }
                      : undefined
                  }
                >
                  <span>{scouted ? `${pct}%` : "not scouted"}</span>
                  {onPinSection ? (
                    <button
                      type="button"
                      onClick={() => onPinSection(r, c)}
                      aria-label={`Pin ${label} · ${COLS[c]}`}
                      className="mt-0.5 block w-full text-[0.55rem] text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Pin
                    </button>
                  ) : null}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      {anyHot ? (
        <p className="text-[0.65rem] text-muted-foreground">
          Ringed: hot spot — this part is clearly worse than the house as a whole. Stay alert there.
        </p>
      ) : null}
    </div>
  );
}
