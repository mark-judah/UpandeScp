import { ProgressBar } from "@/components/ProgressBar";
import { cn } from "@/lib/utils";

interface LoadingOverlayProps {
  open: boolean;
  /**
   * Real progress, 0–100, or `null`/undefined when nothing has measured it yet.
   *
   * `null` is not the same as `0`: it means indeterminate, and the bar sweeps
   * instead of claiming a figure. Pass `null` rather than 0 for "no signal", or the
   * bar will sit at an empty 0% for the whole load and read as stuck.
   */
  progress?: number | null;
  /** What is happening — the server's own stage label reads best here. */
  label?: string;
  weeksLoaded?: number;
  weeksTotal?: number;
  className?: string;
}

/**
 * The app's single loading overlay: dimmed backdrop, one status bar filling left to
 * right.
 *
 * Replaces two near-identical overlays (this one and the Dashboard's
 * `ProgressOverlay`), each of which drew a spinning orbit around a percentage that
 * was usually **simulated** — eased toward 92% on a timer whenever the real channel
 * was quiet, which on the `/scp_app` shell was always, since it loads no socket.
 * The figure shown here comes from the server's own stage reports, and when there
 * is no figure the bar says so by sweeping rather than by guessing.
 */
export function LoadingOverlay({
  open,
  progress,
  label,
  weeksLoaded = 0,
  weeksTotal = 0,
  className,
}: LoadingOverlayProps) {
  if (!open) return null;

  const hasFigure = progress !== null && progress !== undefined;
  // Weeks are a real fraction, so they carry the bar when no percent was reported —
  // they were previously shown only as a caption while the bar itself was faked.
  const fromWeeks =
    weeksTotal > 0 ? (Math.min(weeksLoaded, weeksTotal) / weeksTotal) * 100 : null;
  const percent = hasFigure ? Number(progress) : fromWeeks;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background/40 backdrop-blur-sm",
        "transition-opacity duration-200",
        className,
      )}
    >
      <div className="w-[min(22rem,80vw)]">
        <ProgressBar
          percent={percent}
          label={label}
          detail={
            weeksTotal > 0 ? `${weeksLoaded} of ${weeksTotal} weeks` : undefined
          }
        />
      </div>
    </div>
  );
}
