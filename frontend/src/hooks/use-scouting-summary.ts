import { useEffect, useState } from "react";
import { fetchUnitSummary, summaryData } from "@/lib/scouting-summary";
import type { ProcessedData } from "@/lib/scouting-types";
import { useRealtime } from "./use-realtime";

/** ``pending`` until the server answers; ``raw`` when the page must read raw entries instead
 *  (trees, no crop, or the request failed). */
export type SummaryState = "off" | "pending" | "aggregated" | "raw";

export interface UseScoutingSummaryResult {
  state: SummaryState;
  data: ProcessedData | null;
  loading: boolean;
}

/** One request for the map's per-unit colouring over [from, to]; see lib/scouting-summary. */
export function useScoutingSummary(args: {
  enabled: boolean;
  from: string;
  to: string;
  crop?: string;
  greenhouse?: string;
}): UseScoutingSummaryResult {
  const { enabled, from, to, crop, greenhouse } = args;
  const [state, setState] = useState<SummaryState>(enabled ? "pending" : "off");
  const [data, setData] = useState<ProcessedData | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !from || !to || from > to || !crop) {
      setState(enabled ? "raw" : "off");
      return;
    }
    let alive = true;
    setState((s) => (s === "aggregated" ? s : "pending"));
    fetchUnitSummary({ from, to, crop, greenhouse })
      .then((r) => {
        if (!alive) return;
        if (r?.aggregated) {
          setData(summaryData(r, crop));
          setState("aggregated");
        } else {
          setState("raw");
        }
      })
      .catch((e) => {
        console.error("[scouting] unit summary failed, using raw entries", e);
        if (alive) setState("raw");
      });
    return () => {
      alive = false;
    };
  }, [enabled, from, to, crop, greenhouse, tick]);

  useRealtime("scp:scouting:dirty", () => {
    if (enabled) setTick((n) => n + 1);
  });

  return { state, data, loading: state === "pending" };
}
