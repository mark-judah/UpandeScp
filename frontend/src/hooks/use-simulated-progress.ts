import { useEffect, useState } from "react";

/**
 * Simulated progress that creeps from 0 toward a soft ceiling while
 * ``active`` is true. Used as a fallback when the real progress channel
 * (Frappe realtime ``scp:dash_agg:progress``) is unavailable — the
 * /scp_app shell doesn't load the socket.io bundle, so cold aggregator
 * calls have no progress events. We approximate visual feedback by
 * easing toward the ceiling on an exponential curve; the parent should
 * ``Math.max`` this with any real value it does have.
 *
 *   t = ms elapsed since active became true
 *   pct = ceiling * (1 - exp(-t / tau))   →   never reaches ceiling
 *
 * When ``active`` flips false the value snaps to 100 then resets the
 * next time loading begins.
 */
export function useSimulatedProgress(
  active: boolean,
  opts: { ceiling?: number; tauMs?: number } = {},
): number {
  const ceiling = opts.ceiling ?? 92;
  const tau = opts.tauMs ?? 3500;
  const [pct, setPct] = useState(0);

  useEffect(() => {
    if (!active) {
      // Don't reset to 0 immediately — the parent typically holds the
      // overlay open for a tick after data arrives; jumping to 0 in that
      // window would look broken. Snap to 100 instead; next ``active``
      // cycle resets via the start handler below.
      setPct(100);
      return;
    }
    setPct(0);
    const started = performance.now();
    let raf = 0;
    const tick = () => {
      const t = performance.now() - started;
      const next = ceiling * (1 - Math.exp(-t / tau));
      setPct(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, ceiling, tau]);

  return pct;
}
