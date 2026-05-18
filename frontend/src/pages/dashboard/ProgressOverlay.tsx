import { Progress } from "@/components/ui/progress";
import type { AggregateProgress } from "@/hooks/use-dashboard-aggregate";

/** Inline progress bar shown while a cold-path aggregate is computing.
 *  Renders nothing on warm-cache hits (the hook stays at progress=null
 *  because the server never publishes a progress event when the cache is
 *  warm). */
export function ProgressOverlay({
  progress,
}: {
  progress: AggregateProgress | null;
}) {
  const percent = progress?.percent ?? 0;
  const label = progress?.label ?? "preparing";
  return (
    <div className="flex flex-col gap-3 items-center justify-center min-h-64 px-4">
      <div className="w-full max-w-sm flex flex-col gap-2">
        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>{label}</span>
          <span>{percent}%</span>
        </div>
        <Progress value={percent} className="h-1.5" />
      </div>
      <p className="text-xs text-muted-foreground/70">
        Building dashboard from your scouting data&hellip;
      </p>
    </div>
  );
}
