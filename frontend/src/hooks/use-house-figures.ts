import { useEffect, useState } from "react";

import type { HouseFigure } from "@/lib/pest-bands";
import { fetchHouseFigures } from "@/lib/threshold-figures-api";

/** The server's per-pest figures for one block. Held keyed by the block they
 *  were fetched for, so after a switch A -> B nothing of A's is ever returned
 *  while B's response is pending (pest names overlap across blocks). */
export function useHouseFigures(
  crop: string,
  block: string | null,
  from: string,
  to: string,
): Record<string, HouseFigure> {
  const [held, setHeld] = useState<{ key: string; figs: Record<string, HouseFigure> } | null>(null);
  const key = block ? `${crop}|${block}|${from}|${to}` : null;

  useEffect(() => {
    if (!block || !key) {
      setHeld(null);
      return;
    }
    let cancelled = false;
    void fetchHouseFigures(crop, block, from, to).then((figs) => {
      if (!cancelled) setHeld({ key, figs });
    });
    return () => {
      cancelled = true;
    };
  }, [key, crop, block, from, to]);

  return held && held.key === key ? held.figs : {};
}
