/**
 * Left-to-right reveal wrapper for charts.
 *
 * Recharts' default Bar animation on a `layout="vertical"` chart interpolates
 * both `x` and `width`, so horizontal bars appear to grow outward from the
 * middle. A clip-path wipe is deterministic instead: the content is drawn once,
 * static, and uncovered from one end to the other regardless of chart type or
 * recharts internals.
 *
 * Pair with `isAnimationActive={false}` on the series so the two animations
 * don't fight each other.
 *
 * Honours `prefers-reduced-motion`: the reveal is skipped and content simply
 * appears.
 */

import { cn } from "@/lib/utils";

export function RevealLTR({
  children,
  className,
  durationMs = 700,
  delayMs = 0,
}: {
  children: React.ReactNode;
  className?: string;
  durationMs?: number;
  delayMs?: number;
}) {
  return (
    <div
      className={cn("scp-reveal-ltr", className)}
      style={
        {
          "--scp-reveal-duration": `${durationMs}ms`,
          "--scp-reveal-delay": `${delayMs}ms`,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );
}
