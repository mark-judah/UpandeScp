import { Bar } from "@/components/Loading";
import { cn } from "@/lib/utils";

/**
 * The dashboard cards' list rows (bordered, soft-filled, `px-3 py-2`) before the
 * data lands — same box as the real row, so nothing jumps on arrival. The
 * generic `RowsSkeleton` draws bare lines, which is the wrong shape for these.
 */
export function CardRowsSkeleton({
  rows = 5,
  twoLine = false,
  className,
}: {
  rows?: number;
  /** rows that carry a second, smaller line (name over meta) */
  twoLine?: boolean;
  className?: string;
}) {
  const widths = ["w-40", "w-28", "w-36", "w-24", "w-32", "w-44"];
  return (
    <div className={cn("flex flex-col gap-1.5", className)} aria-hidden data-skeleton="rows">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center justify-between gap-3 rounded-md border bg-[var(--sd-bg-soft)] px-3 py-2"
        >
          <div className="flex min-w-0 flex-col gap-1.5 py-0.5">
            <Bar className={cn("h-3.5 bg-[var(--sd-line)]", widths[i % widths.length])} />
            {twoLine && <Bar className="h-2.5 w-20 bg-[var(--sd-line)]" />}
          </div>
          <Bar className="h-3 w-16 bg-[var(--sd-line)]" />
        </div>
      ))}
    </div>
  );
}
