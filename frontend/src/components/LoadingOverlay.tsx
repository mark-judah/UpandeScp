import { Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface LoadingOverlayProps {
  open: boolean;
  progress: number;
  weeksLoaded?: number;
  weeksTotal?: number;
  className?: string;
}

/**
 * Centered modal overlay shown while scouting data is loading. Reads
 * `progress` (0-100) and the week counter from useScouting. Mount-gated on
 * `open` so an idle page doesn't keep an invisible div capturing pointer
 * events.
 */
export function LoadingOverlay({
  open,
  progress,
  weeksLoaded = 0,
  weeksTotal = 0,
  className,
}: LoadingOverlayProps) {
  if (!open) return null;
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  const showCounter = weeksTotal > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm",
        "transition-opacity duration-200",
        className,
      )}
    >
      <div className="w-[min(90vw,24rem)] rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-3 mb-4">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <div className="flex-1">
            <div className="text-sm font-medium">Loading scouting data…</div>
            {showCounter && (
              <div className="text-xs text-muted-foreground">
                {weeksLoaded} of {weeksTotal} weeks
              </div>
            )}
          </div>
          <div className="text-xs font-mono text-muted-foreground tabular-nums">
            {pct}%
          </div>
        </div>
        <Progress value={pct} />
      </div>
    </div>
  );
}
