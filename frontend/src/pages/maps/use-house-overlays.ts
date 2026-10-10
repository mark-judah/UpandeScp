import { useCallback, useEffect, useState } from "react";
import { getHouseClusters, listPins, patchLine, type HouseClusters, type ScoutingPin } from "@/lib/spread-api";
import type { BedOverlay } from "./BedSvg";

/** One house's patches (one observation, one week) and its pins, for a map. */
export function useHouseOverlays(args: {
  crop: string;
  warehouse: string | null;
  observation: string | null;
  kind: "pest" | "disease";
  week?: string | null;
  withSeries?: boolean;
}) {
  const { crop, warehouse, observation, kind, week, withSeries = false } = args;
  const [clusters, setClusters] = useState<HouseClusters | null>(null);
  const [pins, setPins] = useState<ScoutingPin[]>([]);

  useEffect(() => {
    if (!warehouse || !observation) {
      setClusters(null);
      return;
    }
    let live = true;
    getHouseClusters({ crop, warehouse, observation, kind, week })
      .then((r) => live && setClusters(r))
      .catch(() => live && setClusters(null));
    return () => {
      live = false;
    };
  }, [crop, warehouse, observation, kind, week]);

  const reloadPins = useCallback(() => {
    if (!warehouse) {
      setPins([]);
      return;
    }
    listPins(crop, warehouse, withSeries)
      .then(setPins)
      .catch(() => setPins([]));
  }, [crop, warehouse, withSeries]);
  useEffect(() => reloadPins(), [reloadPins]);

  return { clusters, pins, reloadPins };
}

/** Patches (red, solid) and Patch / Area pins (purple, dashed) as BedSvg
 *  overlays. Section pins live on the 3 × 3 grid, not the map. */
export function bedOverlays(clusters: HouseClusters | null, pins: ScoutingPin[]): BedOverlay[] {
  const out: BedOverlay[] = (clusters?.clusters ?? []).map((p) => ({
    id: `patch-${p.id}`,
    zones: p.stations,
    tone: "patch",
    label: `${patchLine(p, clusters?.unit ?? "bed")} · ${p.change}`,
  }));
  for (const pin of pins) {
    if (pin.kind !== "Section" && pin.stations.length) {
      out.push({ id: `pin-${pin.name}`, zones: pin.stations, tone: "pin", label: pin.title });
    }
  }
  return out;
}
