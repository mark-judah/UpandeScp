import { useEffect, useRef, useState } from "react";
import { call } from "@/lib/frappe";

export interface JobProgress {
  percent: number;
  label: string;
}

const METHOD =
  "upande_scp.serverscripts.dashboard_aggregates._common.job_progress";

/** How often to ask. The server emits progress at named stages, not continuously,
 *  so polling faster than this just returns the same number. */
const POLL_MS = 450;

/**
 * The real server-side progress of an in-flight aggregate call.
 *
 * Why polling rather than the realtime event the server also publishes: the
 * standalone `/scp_app` shell does not load Frappe's socket.io bundle, so
 * `window.frappe.realtime` is undefined and every progress event is dropped. That
 * is the reason the loaders used to animate a *simulated* percentage. The server
 * now also writes each stage to a cache key keyed by job id, and this reads it.
 *
 * Returns `null` until a real figure exists — including for warm-cache hits, which
 * complete before publishing anything. `null` is the signal for the bar to stay
 * indeterminate instead of inventing a number.
 */
export function useJobProgress(
  jobId: string | null | undefined,
  active: boolean,
): JobProgress | null {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  // Progress must never appear to go backwards: a poll can land out of order, and
  // a bar that retreats reads as a bug even when each figure was true when sent.
  const highWaterRef = useRef(0);

  useEffect(() => {
    if (!jobId || !active) {
      setProgress(null);
      highWaterRef.current = 0;
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const out = await call<JobProgress | null>(METHOD, { job_id: jobId });
        if (cancelled) return;
        const pct = Number(out?.percent);
        if (out && Number.isFinite(pct) && pct >= highWaterRef.current) {
          highWaterRef.current = pct;
          setProgress({ percent: pct, label: out.label || "" });
        }
      } catch {
        // A failed poll says nothing about the work it was watching. Keep the last
        // real figure and try again.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, active]);

  return progress;
}
