import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/frappe";
import { useRealtime } from "@/hooks/use-realtime";

export type Endpoint =
  | "overview"
  | "pests"
  | "diseases"
  | "traps"
  | "fcm"
  | "greenhouse_detail";

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

export interface AggregateState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: (opts?: { force?: boolean }) => void;
}

const METHOD: Record<Endpoint, string> = {
  overview:           "upande_scp.serverscripts.dashboard_aggregates.overview",
  pests:              "upande_scp.serverscripts.dashboard_aggregates.pests",
  diseases:           "upande_scp.serverscripts.dashboard_aggregates.diseases",
  traps:              "upande_scp.serverscripts.dashboard_aggregates.traps",
  fcm:                "upande_scp.serverscripts.dashboard_aggregates.fcm",
  greenhouse_detail:  "upande_scp.serverscripts.dashboard_aggregates.greenhouse_detail",
};

export function useDashboardAggregate<T>(
  endpoint: Endpoint,
  filters: AggregateFilters,
  enabled: boolean,
): AggregateState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);

  // Stringify filters once per render so the effect only fires on value change.
  const key = JSON.stringify({ endpoint, ...filters, enabled });

  const fetchOnce = useCallback(
    async (force: boolean) => {
      if (!enabled) return;
      const token = ++tokenRef.current;
      setLoading(true);
      setError(null);
      try {
        const resp = await call<{ message?: T } | T>(
          METHOD[endpoint],
          { ...filters, ...(force ? { force: 1 } : {}) },
        );
        if (tokenRef.current !== token) return;
        // Frappe wraps whitelisted return in { message: ... }
        const payload = (resp as any)?.message ?? (resp as T);
        setData(payload);
      } catch (e: any) {
        if (tokenRef.current !== token) return;
        setError(e?.message || "Failed to load dashboard data");
      } finally {
        if (tokenRef.current === token) setLoading(false);
      }
    },
    // Recompute the closure only when the serialized filter set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    void fetchOnce(false);
  }, [fetchOnce]);

  // Realtime invalidation: a new scouting write busts the server cache,
  // so we just refetch (server returns the fresh version, cached or not).
  useRealtime<{ months?: string[] }>("scp:scouting:dirty", () => {
    void fetchOnce(false);
  });

  return {
    data,
    loading,
    error,
    reload: (opts) => void fetchOnce(Boolean(opts?.force)),
  };
}
