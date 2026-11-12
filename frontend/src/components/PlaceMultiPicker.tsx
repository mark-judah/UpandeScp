/**
 * Multi-select farm and greenhouse picker for list and report pages. Renders the
 * shared TreePicker (the Trends look): a pill with a map-pin, a searchable tree
 * of farms → greenhouses with circular check dots, one header row with
 * "N selected", expand/collapse-all and Select all / Deselect all. A farm row
 * follows its greenhouses (all = ticked, some = half) and toggles them all.
 *
 * `value` is a `PlaceSet` (empty = every farm, so every house shows ticked).
 * Deselect all leaves the panel empty until a pick is made, while the page keeps
 * the "every farm" meaning of an empty set. The last set is remembered per crop
 * under `scp.placeset.<crop>`; an old single `scp.place.<crop>` reads as a
 * one-item set. Pages turn the set into request params with `placeSetParams`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { TreePicker } from "@/components/TreePicker";
import { HEADER_PILL } from "@/components/header-controls";
import {
  ALL_FARMS_LABEL, EMPTY_PLACE_SET, isEmptyPlaceSet, normalizePlaceSet, placeSetLabel,
  placeSetLeaves, readPlaceSet, shortHouse, writePlaceSet, type FarmHouses, type PlaceSet,
} from "@/lib/places";
import { routeCrop } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { TreeNode } from "@/pages/trends/trends-types";

export interface PlaceMultiPickerProps {
  /** farm → greenhouses, or a farm list (farms only) */
  farms: FarmHouses | string[];
  value: PlaceSet;
  onChange: (next: PlaceSet) => void;
  crop?: string;
  /** false opts out of remembering */
  remember?: boolean;
  disabled?: boolean;
  label?: string;
  allLabel?: string;
  className?: string;
}

export function PlaceMultiPicker({
  farms,
  value,
  onChange,
  crop: cropProp,
  remember = true,
  disabled,
  label = "Farms and greenhouses",
  allLabel = ALL_FARMS_LABEL,
  className,
}: PlaceMultiPickerProps) {
  const crop = cropProp ?? routeCrop();
  // Deselect all: the panel shows nothing ticked while the page keeps the empty
  // set (= every farm). Cleared on the next pick and when the popover closes.
  const [none, setNone] = useState(false);

  const farmMap = useMemo<FarmHouses>(
    () => (Array.isArray(farms) ? Object.fromEntries(farms.filter(Boolean).map((f) => [f, []])) : farms),
    [farms],
  );
  const farmNames = useMemo(() => Object.keys(farmMap).filter(Boolean), [farmMap]);
  const leavesOf = (f: string) => (farmMap[f]?.length ? farmMap[f].map((h) => `h:${h}`) : [`f:${f}`]);
  const allLeaves = useMemo(() => farmNames.flatMap(leavesOf), [farmNames, farmMap]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(() => placeSetLeaves(value, farmMap), [value, farmMap]);
  const checked = useMemo(
    () => (none && isEmptyPlaceSet(value) ? new Set<string>() : selected),
    [none, value, selected],
  );

  const nodes = useMemo<TreeNode[]>(
    () =>
      farmNames.map((f) => {
        const houses = farmMap[f] || [];
        return houses.length
          ? {
              id: `f:${f}`,
              label: f,
              children: houses.map((h) => ({
                id: `h:${h}`,
                label: shortHouse(h, f),
                search: `${f} ${h}`,
                title: h,
              })),
            }
          : { id: `f:${f}`, label: f };
      }),
    [farmMap, farmNames],
  );

  const commit = (next: PlaceSet) => {
    onChange(next);
    if (remember) writePlaceSet(crop, next);
  };

  function pick(next: Set<string>) {
    const leaves = new Set([...next].filter((k) => allLeaves.includes(k)));
    setNone(leaves.size === 0);
    // Everything ticked, or nothing ticked, is the empty set: every farm.
    commit(leaves.size === allLeaves.length || leaves.size === 0 ? EMPTY_PLACE_SET : normalizePlaceSet(leaves, farmMap));
  }

  // ── Restore the remembered set once, when the options are in ────────────
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const restoredFor = useRef<string | null>(null);
  const ready = !disabled && farmNames.length > 0;
  useEffect(() => {
    if (!remember || !ready || restoredFor.current === crop) return;
    restoredFor.current = crop;
    if (!isEmptyPlaceSet(latest.current.value)) return; // the page already holds one
    const saved = readPlaceSet(crop);
    if (!saved || isEmptyPlaceSet(saved)) return;
    // Keep only what this page offers.
    const farmsOk = saved.farms.filter((f) => farmNames.includes(f));
    const housesOk = saved.greenhouses.filter((h) => farmNames.some((f) => farmMap[f]?.includes(h)));
    if (!farmsOk.length && !housesOk.length) return;
    latest.current.onChange({ farms: farmsOk, greenhouses: housesOk });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remember, ready, crop]);

  // One farm with nothing to choose between: a fixed label.
  if (farmNames.length === 1 && !farmMap[farmNames[0]]?.length) {
    return (
      <div role="group" aria-label={label} className={cn("inline-flex items-center border", HEADER_PILL, className)}>
        <span className="truncate">{farmNames[0]}</span>
      </div>
    );
  }

  return (
    <TreePicker
      label={label}
      ariaLabel={label}
      valueText={placeSetLabel(value, allLabel)}
      icon={<MapPin className="h-3.5 w-3.5 shrink-0" />}
      disabled={disabled}
      className={className}
      nodes={nodes}
      checked={checked}
      cascade
      onChange={pick}
      onOpenChange={(o) => !o && setNone(false)}
      emptyHint="No farms"
      searchPlaceholder="Search farm or greenhouse"
    />
  );
}
