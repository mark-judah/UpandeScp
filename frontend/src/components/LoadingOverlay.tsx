import { OrbitProgress } from "@/components/OrbitProgress";
import { useSimulatedProgress } from "@/hooks/use-simulated-progress";
import { cn } from "@/lib/utils";

interface LoadingOverlayProps {
  open: boolean;
  progress: number;
  weeksLoaded?: number;
  weeksTotal?: number;
  className?: string;
}

/**
 * Full-screen loader: blurred backdrop with the orbit centred. No card
 * chrome — the orbit + percentage IS the indicator. ``progress`` is
 * augmented with a simulated creep when realtime events aren't wired
 * (the /scp_app shell skips the socket.io bundle), so the arc visibly
 * advances even on cold-cache calls.
 */
export function LoadingOverlay({
  open,
  progress,
  weeksLoaded = 0,
  weeksTotal = 0,
  className,
}: LoadingOverlayProps) {
  const fakePct = useSimulatedProgress(open);
  if (!open) return null;
  const realPct = Math.max(0, Math.min(100, progress));
  const pct = Math.round(Math.max(realPct, fakePct));
  const showCounter = weeksTotal > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/40 backdrop-blur-sm",
        "transition-opacity duration-200",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-3">
        <OrbitProgress percent={pct} size={140} smooth />
        {showCounter ? (
          <div className="text-xs text-muted-foreground">
            {weeksLoaded} of {weeksTotal} weeks
          </div>
        ) : null}
      </div>
    </div>
  );
}
