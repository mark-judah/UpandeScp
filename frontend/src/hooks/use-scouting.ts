import { useEffect, useMemo, useRef, useState } from "react";
import { buildScoutingData } from "@/lib/scouting-api";
import {
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
  greenhouse?: string;
  crop?: string;
}

export interface UseScoutingResult {
  data: ProcessedData | null;
  meta: ScoutingMeta;
  loading: boolean;
  progress: number;
  error: string | null;
  reload: () => void;
}

async function loadAndProcess(args: UseScoutingArgs): Promise<ProcessedData> {
  const rows = await readEntries(args.from, args.to, {
    greenhouse:
      args.greenhouse && args.greenhouse !== "__all__"
        ? args.greenhouse
        : undefined,
    crop: args.crop,
  });
  return buildScoutingData(rows as unknown as RawEntry[]);
}

export function useScouting({
  from,
  to,
  greenhouse,
  crop,
}: UseScoutingArgs): UseScoutingResult {
  const [data, setData] = useState<ProcessedData | null>(null);
  const [meta] = useState<ScoutingMeta>(EMPTY_META);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const tokenRef = useRef(0);

  // Primary load:
  //   1) read whatever's already in IDB → render immediately
  //   2) hydrate any missing months in parallel; re-render after each
  //   3) kick off a background delta sync
  useEffect(() => {
    if (!from || !to || from > to) return;
    const token = ++tokenRef.current;
    setLoading(true);
    setError(null);
    setProgress(10);

    (async () => {
      const refresh = async () => {
        if (tokenRef.current !== token) return;
        try {
          const processed = await loadAndProcess({ from, to, greenhouse, crop });
          if (tokenRef.current === token) setData(processed);
        } catch (e) {
          console.error("[scouting] processing failed", e);
        }
      };

      // 1) Eager render from IDB (instant if anything is cached locally).
      try {
        await refresh();
        if (tokenRef.current !== token) return;
        setProgress(20);
      } catch (e) {
        console.error("[scouting] initial IDB read failed", e);
      }

      // 2) Hydrate missing months. Each month done patches the view.
      try {
        await hydrateRange(from, to, async (loaded, total, month) => {
          if (tokenRef.current !== token) return;
          const span = Math.round(20 + (70 * loaded) / Math.max(1, total));
          setProgress(span);
          console.log(
            `[scouting] hydrated month ${month} (${loaded}/${total})`,
          );
          await refresh();
        });
        if (tokenRef.current !== token) return;
        setProgress(95);
        await refresh();
        setProgress(100);
      } catch (e: any) {
        if (tokenRef.current !== token) return;
        console.error("[scouting] hydrate failed", e);
        setError(e?.message || "Failed to load scouting data");
        return;
      } finally {
        if (tokenRef.current === token) setLoading(false);
      }

      // 3) Background delta — quietly refresh when complete.
      void runDelta()
        .then(async ({ added }) => {
          if (added > 0 && tokenRef.current === token) await refresh();
        })
        .catch((e) => console.error("[scouting] delta failed", e));
    })();
  }, [from, to, greenhouse, crop, tick]);

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
      error,
      reload: () => {
        // Force a re-prime by clearing the loaded-months registry, then re-run.
        void primeAndDelta(from, to).catch(() => {});
        setTick((n) => n + 1);
      },
    }),
    [data, meta, loading, progress, error, from, to],
  );
}
