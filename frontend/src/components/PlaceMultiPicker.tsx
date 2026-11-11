/**
 * Multi-select farm and greenhouse picker for list and report pages — the
 * PlacePicker's sibling, in the ObservationMultiPicker's look. One pill opens a
 * searchable list: "Select all" on top, each farm a tri-state header with its
 * greenhouses indented beneath. The popover stays open while ticking.
 *
 * `value` is a `PlaceSet` (empty = every farm). The last set is remembered per
 * crop under `scp.placeset.<crop>`; an old single `scp.place.<crop>` reads as a
 * one-item set. Pages turn the set into request params with `placeSetParams`.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { SearchInput } from "@/components/SearchInput";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import {
  ALL_FARMS_LABEL, EMPTY_PLACE_SET, isEmptyPlaceSet, matchesQuery, normalizePlaceSet, placeSetLabel,
  placeSetLeaves, readPlaceSet, shortHouse, writePlaceSet, type FarmHouses, type PlaceSet,
} from "@/lib/places";
import { routeCrop } from "@/lib/router";
import { cn } from "@/lib/utils";

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

type Row =
  | { id: string; kind: "all" }
  | { id: string; kind: "farm"; farm: string; leaves: string[] }
  | { id: string; kind: "house"; farm: string; house: string };

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const crop = cropProp ?? routeCrop();

  const farmMap = useMemo<FarmHouses>(
    () => (Array.isArray(farms) ? Object.fromEntries(farms.filter(Boolean).map((f) => [f, []])) : farms),
    [farms],
  );
  const farmNames = useMemo(() => Object.keys(farmMap).filter(Boolean), [farmMap]);
  const leavesOf = (f: string) => (farmMap[f]?.length ? farmMap[f].map((h) => `h:${h}`) : [`f:${f}`]);
  const allLeaves = useMemo(() => farmNames.flatMap(leavesOf), [farmNames, farmMap]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = useMemo(() => placeSetLeaves(value, farmMap), [value, farmMap]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (!query.trim() && farmNames.length) out.push({ id: "all", kind: "all" });
    for (const f of farmNames) {
      const houses = (farmMap[f] || []).filter((h) => matchesQuery(`${f} ${h}`, query));
      if (!matchesQuery(f, query) && !houses.length) continue;
      out.push({ id: `f:${f}`, kind: "farm", farm: f, leaves: leavesOf(f) });
      for (const h of houses) out.push({ id: `h:${h}`, kind: "house", farm: f, house: h });
    }
    return out;
  }, [farmMap, farmNames, query]); // eslint-disable-line react-hooks/exhaustive-deps

  const stateOf = (leaves: string[]): boolean | "indeterminate" => {
    const n = leaves.filter((k) => selected.has(k)).length;
    return n === 0 ? false : n === leaves.length ? true : "indeterminate";
  };

  const commit = (next: PlaceSet) => {
    onChange(next);
    if (remember) writePlaceSet(crop, next);
  };

  function toggleLeaves(leaves: string[]) {
    const next = new Set(selected);
    const all = leaves.every((k) => next.has(k));
    for (const k of leaves) all ? next.delete(k) : next.add(k);
    // Nothing left unticked counts as "all"; nothing ticked falls back to all too.
    const set = next.size === allLeaves.length || next.size === 0 ? EMPTY_PLACE_SET : normalizePlaceSet(next, farmMap);
    commit(set);
  }
  function toggle(row: Row) {
    if (row.kind === "all") commit(EMPTY_PLACE_SET);
    else if (row.kind === "farm") toggleLeaves(row.leaves);
    else toggleLeaves([`h:${row.house}`]);
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

  useEffect(() => {
    if (!open || !active) return;
    const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []).find(
      (n) => n.dataset.row === active,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const i = rows.findIndex((r) => r.id === active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      const n = i < 0 ? (step > 0 ? 0 : rows.length - 1) : (i + step + rows.length) % rows.length;
      setActive(rows[n].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[i] ?? (query.trim() ? rows.find((r) => r.kind !== "all") : undefined);
      if (row) toggle(row);
    }
  };

  const listId = `${baseId}-list`;
  const optionId = (id: string) => `${baseId}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  // One farm with nothing to choose between: a fixed label.
  if (farmNames.length === 1 && !farmMap[farmNames[0]]?.length) {
    return (
      <div role="group" aria-label={label} className={cn("inline-flex items-center border", HEADER_PILL, className)}>
        <span className="truncate">{farmNames[0]}</span>
      </div>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQuery("");
          setActive(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          disabled={disabled}
          className={cn(
            "inline-flex min-w-0 max-w-[16rem] items-center justify-between border text-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            HEADER_PILL,
            className,
          )}
        >
          <span className="truncate">{placeSetLabel(value, allLabel)}</span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-2"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <SearchInput
          ref={inputRef}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(active) : undefined}
          aria-label="Search farms and greenhouses"
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search farm or greenhouse"
          className="mb-1.5"
        />
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="max-h-72 overflow-y-auto"
        >
          {rows.length === 0 && <div className="px-2 py-3 text-center text-xs text-muted-foreground">No match</div>}
          {rows.map((r) => {
            const checked =
              r.kind === "all" ? stateOf(allLeaves) : r.kind === "farm" ? stateOf(r.leaves) : selected.has(`h:${r.house}`);
            const name = r.kind === "all" ? "Select all" : r.kind === "farm" ? r.farm : shortHouse(r.house, r.farm);
            return (
              <div
                key={r.id}
                id={optionId(r.id)}
                data-row={r.id}
                role="option"
                aria-selected={checked === true}
                aria-checked={checked === "indeterminate" ? "mixed" : checked}
                aria-label={name}
                title={r.kind === "house" ? r.house : undefined}
                onMouseMove={() => active !== r.id && setActive(r.id)}
                onClick={() => toggle(r)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm",
                  r.kind === "house" ? "pl-6" : "pl-2 font-medium",
                  r.id === active && "bg-muted",
                )}
              >
                <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {r.kind === "farm" && r.leaves.length > 1 && (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {r.leaves.filter((k) => selected.has(k)).length}/{r.leaves.length}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
