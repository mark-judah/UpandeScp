/**
 * Approved plans and where each is in the process: ONE minimal line per plan —
 * a thin monochrome rule with small step nodes, the current node emphasised.
 * No bar, no colour flow; the percentage is plain text.
 */
import { Fragment, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { FilterSelect } from "@/components/FilterSelect";
import { LifecycleTimelineFor } from "@/components/spray-plan/LifecycleTimeline";
import type { LifecycleSummaryRow } from "@/lib/lifecycle-api";

export const APPROVED_STEPS = [
  { state: "Approved", label: "Approved" },
  { state: "Chemical Issued", label: "Chemical Issued" },
  { state: "Tank Mix Manufactured", label: "Tank Mix" },
  { state: "Spraying In Progress", label: "Spraying" },
  { state: "Completed", label: "Completed" },
] as const;

/** Index of a workflow state on the line, or -1 when it is not an approved one. */
export function stepIndex(state: string | null | undefined): number {
  return APPROVED_STEPS.findIndex((s) => s.state === state);
}

/** Progress as a whole percent: reaching step i of N is (i + 1) / N. */
export function progressPct(index: number): number {
  if (index < 0) return 0;
  return Math.round(((index + 1) / APPROVED_STEPS.length) * 100);
}

export function isApprovedRow(r: LifecycleSummaryRow): boolean {
  return stepIndex(r.current_state) >= 0;
}

function when(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16);
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function StepLine({ index }: { index: number }) {
  return (
    <div className="flex items-center" role="img" aria-label={`Step ${index + 1} of ${APPROVED_STEPS.length}: ${APPROVED_STEPS[Math.max(0, index)].label}`}>
      {APPROVED_STEPS.map((s, i) => (
        <Fragment key={s.state}>
          <div className="flex flex-col items-center gap-1">
            <span
              data-testid="step-node"
              data-current={i === index ? "true" : undefined}
              className={cn(
                "block rounded-full border transition-all",
                i === index
                  ? "h-3 w-3 border-foreground bg-foreground ring-4 ring-foreground/10"
                  : i < index
                    ? "h-2 w-2 border-foreground/60 bg-foreground/60"
                    : "h-2 w-2 border-foreground/25 bg-background",
              )}
            />
            <span className={cn("whitespace-nowrap text-[0.6rem]", i === index ? "font-semibold text-foreground" : "text-muted-foreground")}>
              {s.label}
            </span>
          </div>
          {i < APPROVED_STEPS.length - 1 && (
            <span className={cn("mx-1 mb-4 h-px min-w-6 flex-1", i < index ? "bg-foreground/50" : "bg-foreground/15")} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

export function ApprovedList({ rows, loading }: { rows: LifecycleSummaryRow[]; loading: boolean }) {
  const [step, setStep] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const approved = useMemo(() => rows.filter(isApprovedRow), [rows]);
  const shown = useMemo(
    () => (step ? approved.filter((r) => r.current_state === step) : approved),
    [approved, step],
  );
  if (!approved.length) {
    return (
      <div className="rounded-xl border bg-card p-10 text-center text-sm text-muted-foreground">
        {loading ? "Loading approved plans…" : "No approved plans in this selection."}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="approved-list">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FilterSelect
          label="Step"
          value={step}
          onChange={setStep}
          allLabel="All steps"
          options={APPROVED_STEPS.map((s) => s.state)}
          format={(o) => APPROVED_STEPS.find((s) => s.state === o)?.label ?? o}
        />
        <span>{shown.length} plan{shown.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="divide-y rounded-xl border bg-card">
        {shown.map((r) => {
          const i = stepIndex(r.current_state);
          return (
            <li key={r.name} className="px-4 py-3" data-testid="approved-row">
              <button
                type="button"
                onClick={() => setOpen(open === r.name ? null : r.name)}
                className="grid w-full grid-cols-1 items-center gap-3 text-left md:grid-cols-[14rem_1fr_9rem]"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{r.name}</div>
                  <div className="truncate text-[0.7rem] text-muted-foreground">{r.greenhouse || "—"}</div>
                </div>
                <StepLine index={i} />
                <div className="text-right text-[0.7rem] tabular-nums text-muted-foreground">
                  <div className="text-sm font-semibold text-foreground" data-testid="progress-pct">{progressPct(i)}%</div>
                  <div>{when(r.last_step_at ?? r.scheduled)}</div>
                </div>
              </button>
              {open === r.name && (
                <div className="mt-3 border-t pt-3">
                  <LifecycleTimelineFor workOrder={r.name} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
