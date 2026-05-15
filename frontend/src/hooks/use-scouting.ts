import { useEffect, useMemo, useRef, useState } from "react";
import { buildScoutingData } from "@/lib/scouting-api";
import {
  getMissingWeeks,
  hydrateRange,
  invalidateMonth,
  primeAndDelta,
  readEntries,
  runDelta,
} from "@/lib/scouting-sync";
import { useRealtime } from "./use-realtime";
import type {
  ProcessedData,
  RawEntry,
  ScoutingMeta,
} from "@/lib/scouting-types";

const EMPTY_META: ScoutingMeta = {
  pestColors: {},
  diseaseColors: {},
  zonesByGreenhouse: {},
  unitsByGreenhouse: {},
  cropsScouted: [],
};

export interface UseScoutingArgs {
  from: string;
  to: string;
  /** Convenience for pages that only ever select a single greenhouse. */
  greenhouse?: string;
  /** Explicit allow-list of greenhouses — used by pages that need to
   *  express "every greenhouse on this farm" without dropping back to
   *  an unfiltered fetch. Takes precedence over ``greenhouse`` when both
   *  are set. */
  greenhouses?: string[];
  crop?: string;
}

export interface UseScoutingResult {
  data: ProcessedData | null;
  meta: ScoutingMeta;
  loading: boolean;
  progress: number;
  weeksLoaded: number;
  weeksTotal: number;
  error: string | null;
  reload: () => void;
}

async function loadAndProcess(args: UseScoutingArgs): Promise<ProcessedData> {
  const rows = await readEntries(args.from, args.to, {
    greenhouse:
      args.greenhouse && args.greenhouse !== "__all__"
        ? args.greenhouse
        : undefined,
    greenhouses: args.greenhouses,
    crop: args.crop,
  });
  return buildScoutingData(rows as unknown as RawEntry[]);
}

export function useScouting({
  from,
  to,
  greenhouse,
  greenhouses,
  crop,
}: UseScoutingArgs): UseScoutingResult {
  const [data, setData] = useState<ProcessedData | null>(null);
  const [meta] = useState<ScoutingMeta>(EMPTY_META);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [weeksLoaded, setWeeksLoaded] = useState(0);
  const [weeksTotal, setWeeksTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const tokenRef = useRef(0);

  // Memoise the greenhouses list so we don't re-fire the render effect every
  // render when callers spread a fresh array literal.
  const greenhousesKey = greenhouses
    ? greenhouses.slice().sort().join("|")
    : "";

  // Shared filter+render — used by both effects below.
  const buildAndSet = async (token: number) => {
    if (tokenRef.current !== token) return;
    try {
      const processed = await loadAndProcess({
        from,
        to,
        greenhouse,
        greenhouses,
        crop,
      });
      if (tokenRef.current === token) setData(processed);
    } catch (e) {
      console.error("[scouting] processing failed", e);
    }
  };

  // Effect A — Hydration. Runs only when the date range (or a manual reload)
  // changes. Owns loading / progress / weeks counters. Skips the loading
  // state entirely when everything is already cached so greenhouse switches
  // (handled by Effect B) never flash a loading indicator.
  useEffect(() => {
    if (!from || !to || from > to) return;
    const token = ++tokenRef.current;
    setError(null);

    (async () => {
      const missing = await getMissingWeeks(from, to);
      if (tokenRef.current !== token) return;

      if (missing.length === 0) {
        // Cached path — Effect B will refresh data; nothing for us to do.
        setLoading(false);
        setProgress(100);
        setWeeksLoaded(0);
        setWeeksTotal(0);
        return;
      }

      setLoading(true);
      setProgress(0);
      setWeeksLoaded(0);
      setWeeksTotal(missing.length);

      try {
        await hydrateRange(from, to, (loaded, total, week) => {
          if (tokenRef.current !== token) return;
          setWeeksLoaded(loaded);
          setWeeksTotal(total);
          setProgress(Math.round((100 * loaded) / Math.max(1, total)));
          console.log(`[scouting] hydrated week ${week} (${loaded}/${total})`);
        });
        if (tokenRef.current !== token) return;
        setProgress(100);
      } catch (e: any) {
        if (tokenRef.current !== token) return;
        console.error("[scouting] hydrate failed", e);
        setError(e?.message || "Failed to load scouting data");
        return;
      } finally {
        if (tokenRef.current === token) setLoading(false);
      }

      // Background delta — quietly refresh when complete.
      void runDelta()
        .then(async ({ added }) => {
          if (added > 0 && tokenRef.current === token) {
            await buildAndSet(token);
          }
        })
        .catch((e) => console.error("[scouting] delta failed", e));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, tick]);

  // Effect B — Render. Runs whenever filters change (and also after Effect A
  // mutates IDB, because `tick` and range are shared). Pure IDB-read +
  // ProcessedData rebuild; never touches loading/progress.
  useEffect(() => {
    if (!from || !to || from > to) return;
    const token = tokenRef.current;
    void buildAndSet(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, greenhouse, greenhousesKey, crop, tick, weeksLoaded]);

  // Realtime: invalidate the affected month and re-render.
  useRealtime("scp:scouting:dirty", async (payload: { months?: string[] }) => {
    const months = payload?.months || [];
    if (!months.length) {
      await invalidateMonth(null);
    } else {
      await Promise.all(months.map(invalidateMonth));
    }
    setTick((n) => n + 1);
  });

  return useMemo(
    () => ({
      data,
      meta,
      loading,
      progress,
      weeksLoaded,
      weeksTotal,
      error,
      reload: () => {
        void primeAndDelta(from, to).catch(() => {});
        setTick((n) => n + 1);
      },
    }),
    [data, meta, loading, progress, weeksLoaded, weeksTotal, error, from, to],
  );
}
