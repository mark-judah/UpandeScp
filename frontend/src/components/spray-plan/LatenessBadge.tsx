/**
 * A plan's lateness grade and postponement mark, one definition for every page.
 *
 * The grade comes from the server (`spray_plan_creator/lateness.py`): amber from the
 * planned time, orange from half-way to the day's cutoff, red in the last tenth, and
 * "Missed" only after the cutoff. It is a label; nothing is stopped by it.
 */
import { AlertTriangle, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";

export type LatenessLevel = "none" | "amber" | "orange" | "red" | "missed";

const TONE: Record<Exclude<LatenessLevel, "none">, { label: string; cls: string }> = {
  amber: { label: "Running late", cls: "text-amber-600 dark:text-amber-400" },
  orange: { label: "Late", cls: "text-orange-600 dark:text-orange-400" },
  red: { label: "Very late", cls: "text-red-600 dark:text-red-400" },
  missed: { label: "Missed", cls: "text-[var(--sd-data-red)] font-semibold" },
};

export function latenessLabel(level: LatenessLevel | null | undefined): string {
  return level && level !== "none" ? TONE[level].label : "";
}

export function LatenessBadge({
  level,
  missed,
  postponed,
  postponedFrom,
  className,
}: {
  level?: LatenessLevel | null;
  /** Legacy flag: treated as "missed" when no level is sent. */
  missed?: boolean;
  postponed?: boolean;
  postponedFrom?: string | null;
  className?: string;
}) {
  const grade: LatenessLevel = level && level !== "none" ? level : missed ? "missed" : "none";
  if (grade === "none" && !postponed) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      {grade !== "none" && (
        <span
          className={cn("inline-flex items-center gap-1 text-[0.6rem] font-medium", TONE[grade].cls)}
          data-lateness={grade}
        >
          <AlertTriangle className="h-3 w-3" />
          {TONE[grade].label}
        </span>
      )}
      {postponed && (
        <span className="inline-flex items-center gap-1 text-[0.6rem] font-medium text-muted-foreground">
          <CalendarClock className="h-3 w-3" />
          Postponed{postponedFrom ? ` from ${postponedFrom.slice(0, 10)}` : ""}
        </span>
      )}
    </span>
  );
}
