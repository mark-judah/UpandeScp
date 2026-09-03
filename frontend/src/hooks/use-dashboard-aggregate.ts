import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/frappe";
import { errorText } from "@/lib/errors";
import { useRealtime } from "@/hooks/use-realtime";
import { useJobProgress } from "@/hooks/use-job-progress";

export type Endpoint =
  | "overview"
  | "pests"
  | "diseases"
  | "traps"
  | "fcm"
  | "greenhouse_detail"
  | "heatmaps_grid"
  | "heatmap_card_detail"
  | "heatmap_terrain"
  | "application_plan_diagnose"
  | "trends";

export interface AggregateFilters {
  from_date: string;
  to_date: string;
  crop?: string;
  farm?: string;
  greenhouse?: string;
  observation?: string;
  section?: string;
  stage?: string;
}

export interface AggregateProgress {
  percent: number;
  label: string;
}

export interface AggregateState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Non-null only once a cold-path fetch has reported a stage. Warm-cache hits
   *  never publish, so this stays null and the bar stays indeterminate rather than
   *  showing a number nobody measured. */
  progress: AggregateProgress | null;
  reload: (opts?: { force?: boolean }) => void;
}

export const METHOD: Record<Endpoint, string> = {
  overview:           "upande_scp.serverscripts.dashboard_aggregates.overview",
  pests:              "upande_scp.serverscripts.dashboard_aggregates.pests",
  diseases:           "upande_scp.serverscripts.dashboard_aggregates.diseases",
  traps:              "upande_scp.serverscripts.dashboard_aggregates.traps",
  fcm:                "upande_scp.serverscripts.dashboard_aggregates.fcm",
  greenhouse_detail:  "upande_scp.serverscripts.dashboard_aggregates.greenhouse_detail",
  heatmaps_grid:      "upande_scp.serverscripts.dashboard_aggregates.heatmaps_grid",
  heatmap_card_detail:
    "upande_scp.serverscripts.dashboard_aggregates.heatmap_card_detail",
  heatmap_terrain:
    "upande_scp.serverscripts.dashboard_aggregates.heatmap_terrain",
  application_plan_diagnose:
    "upande_scp.serverscripts.dashboard_aggregates.application_plan_diagnose",
  trends:             "upande_scp.serverscripts.dashboard_aggregates.trends",
};

function newJobId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for very old browsers — collision odds are still negligible at
  // the scale of one operator's session.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function useDashboardAggregate<T>(
  endpoint: Endpoint,
  filters: AggregateFilters,
  enabled: boolean,
): AggregateState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AggregateProgress | null>(null);
  // Mirrored into state as well as the ref: the ref filters stale realtime events,
  // while the polling hook needs a value that re-renders when it changes.
  const [jobId, setJobId] = useState<string>("");
  const tokenRef = useRef(0);
  // Job id of the *currently-in-flight* fetch. Realtime progress events from
  // older fetches (e.g. rapid filter changes) are filtered out by comparing
  // their job_id to this ref.
  const jobIdRef = useRef<string>("");

  const key = JSON.stringify({ endpoint, ...filters, enabled });

  const fetchOnce = useCallback(
    async (force: boolean) => {
      if (!enabled) return;
      const token = ++tokenRef.current;
      const job_id = newJobId();
      jobIdRef.current = job_id;
      setJobId(job_id);
      setLoading(true);
      setError(null);
      setProgress(null);
      try {
        const resp = await call<{ message?: T } | T>(
          METHOD[endpoint],
          { ...filters, job_id, ...(force ? { force: 1 } : {}) },
        );
        if (tokenRef.current !== token) return;
        const payload = (resp as any)?.message ?? (resp as T);
        setData(payload);
      } catch (e: any) {
        if (tokenRef.current !== token) return;
        setError(errorText(e, "Failed to load dashboard data"));
      } finally {
        if (tokenRef.current === token) {
          setLoading(false);
          setProgress(null);
          jobIdRef.current = "";
          setJobId("");
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    void fetchOnce(false);
  }, [fetchOnce]);

  const onDirty = useCallback(() => {
    void fetchOnce(false);
  }, [fetchOnce]);
  useRealtime<{ months?: string[] }>("scp:scouting:dirty", onDirty);

  const onProgress = useCallback(
    (msg: { job_id?: string; percent?: number; label?: string } | undefined) => {
      if (!msg || msg.job_id !== jobIdRef.current) return;
      const percent = Math.max(0, Math.min(100, Number(msg.percent) || 0));
      setProgress({ percent, label: msg.label || "" });
    },
    [],
  );
  useRealtime("scp:dash_agg:progress", onProgress);

  // Two sources for the same figure: the realtime event (Desk-hosted, arrives
  // first) and the polled cache key (the /scp_app shell, which has no socket).
  // Whichever is further along wins; neither is simulated.
  const polled = useJobProgress(jobId, loading);
  const merged =
    polled && (!progress || polled.percent > progress.percent) ? polled : progress;

  return {
    data,
    loading,
    error,
    progress: merged,
    reload: (opts) => void fetchOnce(Boolean(opts?.force)),
  };
}
