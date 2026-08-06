import { useEffect, useMemo, useRef, useState } from "react";
import { buildScoutingData } from "@/lib/scouting-api";
import {
  getMissingWeeks,
  hydrateRange,
  invalidateMonth,
  primeAndDelta,
  readEntries,
  refreshRecentWeeks,
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

  // Shared filter+render — used by both effects below. Flips ``loading``
  // for the duration of the IDB read+rebuild so consumers see the orbit
  // overlay on every filter change, not just the first cold load.
  const buildAndSet = async (
    token: number,
    opts: { silent?: boolean } = {},
  ) => {
    if (tokenRef.current !== token) return;
    const silent = opts.silent ?? false;
    if (!silent) setLoading(true);
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
    } finally {
      if (!silent && tokenRef.current === token) setLoading(false);
    }
  };

  // Effect A — Hydration. Runs only when the date range (or a manual reload)
  // changes. Owns loading / progress / weeks counters. Blocks ONLY on weeks
  // genuinely never loaded into IDB; recent weeks that are already cached are
  // refreshed in the background so opening a map never waits on the network
  // once the cache is warm.
  useEffect(() => {
    if (!from || !to || from > to) return;
    const token = ++tokenRef.current;
    setError(null);
    // Scope the fetch to a single sparse crop (e.g. avocado) so long ranges
    // pull only that crop's rows and cache all history; rose / unset keeps the
    // shared all-crop path.
    const scopedCrop = crop && crop !== "Rose" ? crop : undefined;
    // Scope the fetch to a single greenhouse when the page picked exactly one
    // and isn't asking for a multi-greenhouse list — that's the all/multi
    // mode's unfiltered path, which must keep working exactly as it does
    // today (see the R7 scope boundary).
    const scopedGreenhouse =
      greenhouse && greenhouse !== "__all__" && !greenhousesKey
        ? greenhouse
        : undefined;

    (async () => {
      // Cold weeks only — those never loaded into IDB. We deliberately do NOT
      // invalidate recent weeks up front: that used to make already-cached
      // weeks look "missing" and forced the loading overlay over an otherwise
      // instant cached paint (Effect B reads IDB on mount). Freshness for
      // recent weeks now happens in the non-blocking refresh below.
      const missing = await getMissingWeeks(from, to, scopedCrop, scopedGreenhouse);
      if (tokenRef.current !== token) return;

      if (missing.length === 0) {
        // Warm cache — don't touch ``loading``. Effect B owns the IDB
        // read+rebuild and toggles loading around that, so warm-cache filter
        // changes still show the orbit for the brief rebuild window.
        setProgress(100);
        setWeeksLoaded(0);
        setWeeksTotal(0);
      } else {
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
          }, scopedCrop, scopedGreenhouse);
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
      }

      // Background freshness — never toggles ``loading``, so the cached paint
      // stays on screen. Re-fetches the ISO weeks touching the last 14 days
      // that this range actually views (catches offline mobile rows whose
      // ``modified`` predates our delta watermark — the reason this refresh
      // exists) and advances the watermark via delta. Re-renders SILENTLY,
      // only when rows actually changed, so there's no overlay flash.
      void refreshRecentWeeks(from, to, 7, scopedCrop, scopedGreenhouse)
        .then(async (changed) => {
          if (changed && tokenRef.current === token) {
            await buildAndSet(token, { silent: true });
          }
        })
        .catch((e) => console.error("[scouting] background refresh failed", e));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, tick, crop, greenhouse, greenhousesKey]);

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
