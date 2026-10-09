import { Fragment } from "react";
import { cn } from "@/lib/utils";
import type { SectionCell } from "@/lib/prevalence";

const ROWS = ["First third", "Middle third", "Last third"];
const COLS = ["Front", "Middle", "Back"];

/** The house as a 3 × 3 grid: rows are thirds of its beds (or orchard rows) in
 *  order, columns the front / middle / back of each bed. Each cell shows its
 *  prevalence; a cell with fewer than 3 stations scouted is greyed "not scouted"
 *  because it does not enter the adjusted figure. */
export function SectionGrid({ sections }: { sections: SectionCell[] }) {
  const at = new Map(sections.map((s) => [`${s.row}:${s.col}`, s]));
  return (
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
            return (
              <div
                key={c}
                data-testid={`section-${r}-${c}`}
                data-scouted={scouted ? "true" : "false"}
                title={s ? `${s.infested} of ${s.scouted} stations scouted` : "no stations"}
                className={cn(
                  "rounded-md border px-2 py-2 text-center tabular-nums",
                  scouted ? "text-foreground" : "bg-[var(--sd-bg-soft)] text-muted-foreground opacity-60",
                )}
                style={
                  scouted
                    ? { background: `color-mix(in srgb, var(--sd-data-red) ${Math.min(60, Math.round(pct))}%, var(--sd-card))` }
                    : undefined
                }
              >
                {scouted ? `${pct}%` : "not scouted"}
              </div>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
