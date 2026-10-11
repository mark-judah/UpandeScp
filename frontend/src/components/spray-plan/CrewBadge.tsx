import { CREW_STATUS_LABEL, type CrewStatus } from "@/lib/schedule-api";
import { cn } from "@/lib/utils";

const TONE: Record<Exclude<CrewStatus, "ok">, string> = {
  on_leave: "bg-red-500/15 text-red-700 dark:text-red-300",
  leave_pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  not_checked_in: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};

/** A small pill naming why a crew member may not be available. Nothing for "ok". */
export function CrewBadge({
  status,
  halfDay,
  className,
}: {
  status: CrewStatus | undefined | null;
  halfDay?: boolean;
  className?: string;
}) {
  if (!status || status === "ok") return null;
  return (
    <span
      data-testid="crew-badge"
      data-status={status}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-1.5 py-0.5 text-[0.6rem] font-semibold",
        TONE[status],
        className,
      )}
    >
      {CREW_STATUS_LABEL[status]}
      {halfDay ? " (half day)" : ""}
    </span>
  );
}
