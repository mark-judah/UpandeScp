/**
 * LifecycleTimeline — vertical stepper rendering a spray plan's full
 * cradle-to-grave progress from the ``get_lifecycle`` payload. Used on the
 * Approvals (GM), Historical (creator) and Chemical Progress (storesman)
 * pages so the lifecycle looks identical everywhere.
 */
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  CircleDot,
  AlertTriangle,
  MinusCircle,
  Ban,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Bar, TextSkeleton } from "@/components/Loading";
import {
  fetchLifecycle,
  type Lifecycle,
  type LifecycleStep,
  type StepStatus,
} from "@/lib/lifecycle-api";

const STATUS_META: Record<
  StepStatus,
  { Icon: React.ComponentType<{ className?: string }>; tone: string; line: string }
> = {
  done: {
    Icon: CheckCircle2,
    tone: "text-[var(--sd-data-green)]",
    line: "bg-[var(--sd-data-green)]/40",
  },
  current: {
    Icon: CircleDot,
    tone: "text-primary",
    line: "bg-border",
  },
  pending: {
    Icon: Circle,
    tone: "text-muted-foreground/40",
    line: "bg-border",
  },
  warning: {
    Icon: AlertTriangle,
    tone: "text-[var(--sd-data-red)]",
    line: "bg-border",
  },
  skipped: {
    Icon: MinusCircle,
    tone: "text-muted-foreground/30",
    line: "bg-border",
  },
};

function fmtTs(ts: string | null): string {
  if (!ts) return "";
  // Backend sends "YYYY-MM-DD HH:MM:SS" (local). Show a compact form.
  const [date, time] = ts.split(" ");
  if (!date) return ts;
  const d = new Date(`${date}T${time || "00:00:00"}`);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StepRow({
  step,
  isLast,
}: {
  step: LifecycleStep;
  isLast: boolean;
}) {
  const meta = STATUS_META[step.status];
  const { Icon } = meta;
  const muted = step.status === "pending" || step.status === "skipped";
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            meta.tone,
            step.status === "current" && "animate-pulse",
          )}
        />
        {!isLast && <span className={cn("w-px flex-1 my-1", meta.line)} />}
      </div>
      <div className={cn("pb-4 min-w-0 flex-1", isLast && "pb-0")}>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "text-sm font-medium leading-none",
              muted && "text-muted-foreground",
            )}
          >
            {step.label}
          </span>
          {step.status === "current" && (
            <Badge className="bg-primary/15 text-primary hover:bg-primary/15 text-[0.6rem]">
              In progress
            </Badge>
          )}
          {step.status === "warning" && (
            <Badge className="bg-[var(--sd-data-red)]/15 text-[var(--sd-data-red)] text-[0.6rem]">
              Missed window
            </Badge>
          )}
          {step.timestamp && (
            <span className="text-[0.7rem] text-muted-foreground tabular-nums ml-auto">
              {fmtTs(step.timestamp)}
            </span>
          )}
        </div>
        {(step.actor || step.detail) && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {step.actor && <span className="font-medium">{step.actor}</span>}
            {step.actor && step.detail && <span> · </span>}
            {step.detail && <span>{step.detail}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

export function LifecycleTimeline({
  lifecycle,
  loading,
  className,
}: {
  lifecycle: Lifecycle | null;
  loading?: boolean;
  className?: string;
}) {
  if (loading) {
    // The timeline's own frame — heading, then step rows down a rail — with
    // the state badge and each step's label and time pulsing.
    return (
      <div className={cn("flex flex-col gap-3", className)} aria-busy="true">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground font-medium">
            Lifecycle
          </span>
          <Bar className="h-5 w-24 rounded-full" />
        </div>
        <ol className="flex flex-col" aria-hidden>
          {["9rem", "11rem", "8rem", "10rem", "7rem"].map((w, i, all) => (
            <li key={i} className="flex gap-3" data-skeleton="step">
              <div className="flex flex-col items-center">
                <span className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-[var(--sd-bg-soft)]" />
                {i < all.length - 1 && <span className="w-px flex-1 my-1 bg-border" />}
              </div>
              <div className={cn("pb-4 min-w-0 flex-1 flex items-center gap-2", i === all.length - 1 && "pb-0")}>
                <TextSkeleton width={w} />
                <span className="ml-auto">
                  <TextSkeleton width="5rem" />
                </span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (!lifecycle) return null;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground font-medium">
          Lifecycle
        </span>
        <Badge variant="outline" className="text-[0.65rem]">
          {lifecycle.current_state}
        </Badge>
        {lifecycle.stopped && (
          <Badge className="bg-[var(--sd-data-red)]/15 text-[var(--sd-data-red)] text-[0.65rem] gap-1">
            <Ban className="h-3 w-3" />
            Cancelled
          </Badge>
        )}
      </div>
      {lifecycle.stopped && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--sd-data-red)]/40 bg-[var(--sd-data-red)]/5 px-3 py-2 text-xs text-[var(--sd-data-red)]">
          <Ban className="h-3.5 w-3.5 shrink-0" />
          This plan was stopped / cancelled — remaining steps will not run.
        </div>
      )}
      <ol className="flex flex-col">
        {lifecycle.steps.map((step, i) => (
          <StepRow
            key={step.key}
            step={step}
            isLast={i === lifecycle.steps.length - 1}
          />
        ))}
      </ol>
    </div>
  );
}

/** Self-fetching variant — drop it in wherever a row expands and it loads its
 *  own lifecycle on mount. Avoids the parent juggling a per-row cache. */
export function LifecycleTimelineFor({
  workOrder,
  className,
}: {
  workOrder: string;
  className?: string;
}) {
  const [lc, setLc] = useState<Lifecycle | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLc(null);
    fetchLifecycle(workOrder)
      .then((d) => !cancelled && setLc(d))
      .catch(() => !cancelled && setLc(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [workOrder]);
  return <LifecycleTimeline lifecycle={lc} loading={loading} className={className} />;
}
