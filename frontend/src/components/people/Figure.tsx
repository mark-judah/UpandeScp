/**
 * One number and what it means; a row of them on one recessed panel.
 * Ported from the Livestock app's Figure (not imported across apps).
 */
import * as React from "react";
import { cn } from "@/lib/utils";

const EMPTY = "—";

export function Figure({
  label,
  value,
  unit,
  hint,
  loading,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  /** Draw the figure's own box with a bar where the number will be, so the
   *  row keeps its height when the data lands. */
  loading?: boolean;
}) {
  const empty = value === EMPTY || value === "";
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-5 py-4">
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--sd-quiet)]">
        {label}
      </span>
      {loading ? (
        <>
          <span className="block h-[26px] w-[4.5ch] animate-pulse rounded bg-[var(--sd-line-soft)]" />
          <span className="block h-4 w-[7ch] animate-pulse rounded bg-[var(--sd-line-soft)]" />
        </>
      ) : (
        <>
          <span
            className={cn(
              "text-[26px] font-semibold leading-none tracking-[-0.025em] tabular-nums",
              empty ? "text-[var(--sd-quiet)]" : "text-[var(--sd-ink)]",
            )}
          >
            {empty ? EMPTY : value}
            {unit && !empty && (
              <span className="ml-1 text-[12px] font-medium text-[var(--sd-muted)]">{unit}</span>
            )}
          </span>
          <span className="min-h-[1rem] text-[11px] text-[var(--sd-quiet)]">{hint || ""}</span>
        </>
      )}
    </div>
  );
}

/** The column count comes from the children, so two figures never leave half a panel empty. */
export function FigureRow({ children }: { children: React.ReactNode }) {
  const count = React.Children.toArray(children).length;
  const columns =
    count <= 1
      ? "grid-cols-1"
      : count === 2
        ? "grid-cols-2"
        : count === 3
          ? "grid-cols-2 sm:grid-cols-3"
          : "grid-cols-2 sm:grid-cols-4";
  return (
    <div
      className={cn(
        "grid gap-y-4 rounded-[var(--sd-radius-lg)] bg-[var(--sd-bg-soft)] px-1 py-1 shadow-[inset_0_1px_2px_rgba(10,10,10,0.06)]",
        columns,
      )}
    >
      {children}
    </div>
  );
}
