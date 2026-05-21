import { OrbitProgress } from "@/components/OrbitProgress";
import { useSimulatedProgress } from "@/hooks/use-simulated-progress";
import type { AggregateProgress } from "@/hooks/use-dashboard-aggregate";

/**
 * Full-screen loader for the Dashboard tabs. Mirrors the Trends overlay:
 * blurred backdrop, centred orbit, no card chrome. Picks the larger of
 * the real ``progress.percent`` and the simulated creep, so cold-cache
 * loads still show smooth motion even though the /scp_app shell can't
 * receive the server's realtime progress events.
 */
export function ProgressOverlay({
  progress,
}: {
  progress: AggregateProgress | null;
}) {
  const realPct = progress?.percent ?? 0;
  const fakePct = useSimulatedProgress(true);
  const displayed = Math.round(Math.max(realPct, fakePct));
  const label = progress?.label ?? "preparing";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-valuenow={displayed}
      aria-valuemin={0}
      aria-valuemax={100}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/40 backdrop-blur-sm transition-opacity duration-200"
    >
      <div className="flex flex-col items-center gap-3">
        <OrbitProgress percent={displayed} size={140} label={label} smooth />
      </div>
    </div>
  );
}
