/**
 * The one farm and greenhouse picker (place picker spec 2026-10-12 G1–G5).
 *
 * A single pill that opens a searchable list: "All farms", then each farm
 * with its greenhouses indented beneath it, written short ("GH 16"). Picking
 * a farm filters to the farm; picking a greenhouse filters to that house and
 * its farm. The pill reads "All farms" · "Chepsito" · "Chepsito · GH 16".
 *
 * `level` narrows it: "farm" lists farms only; "greenhouse" needs a house and
 * shows the farms as headers only. The last place picked is remembered per
 * crop (`scp.place.<crop>`) and restored once the options load — a remembered
 * place this page doesn't offer is ignored and left in storage.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import {
  ALL_FARMS_LABEL, farmOf, houseLabel, housesOf, matchesQuery, readPlace, shortHouse, writePlace,
  type FarmHouses, type Place,
} from "@/lib/places";
import { routeCrop } from "@/lib/router";
import { cn } from "@/lib/utils";

export type PlaceLevel = "both" | "farm" | "greenhouse";

export interface PlacePickerProps {
  /** farm → greenhouses (the `useCropFarms` shape), or a farm list for `level="farm"`. */
  farms: FarmHouses | string[];
  value: Place;
  onChange: (next: Place) => void;
  level?: PlaceLevel;
  /** the crop the remembered place is kept under; defaults to the route's
   *  crop, so the crop-less spray pages share it with the scouting pages */
  crop?: string;
  /** false opts out of remembering (dialogs, settings) */
  remember?: boolean;
  disabled?: boolean;
  /** "pill" (default) is the header look; "field" the boxed form-field look. */
  variant?: "pill" | "field";
  /** the "All farms" option; false where the page has no "all" */
  allLabel?: string | false;
  /** accessible name */
  label?: string;
  /** pill text while nothing is picked and there is no "all" */
  placeholder?: string;
  /** something drawn at the end of a greenhouse's row (a badge) */
  houseExtra?: (house: string) => ReactNode;
  className?: string;
}

type Row =
  | { id: string; kind: "all" }
  | { id: string; kind: "farm"; farm: string; header: boolean }
  | { id: string; kind: "house"; farm: string; house: string };

/** Bordered box matching the Select triggers on form pages. */
const FIELD_TRIGGER =
  "h-9 w-full gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-sm";

export function PlacePicker({
  farms,
  value,
  onChange,
  level = "both",
  crop: cropProp,
  remember = true,
  disabled,
  variant = "pill",
  allLabel = ALL_FARMS_LABEL,
  label = level === "farm" ? "Farm" : level === "greenhouse" ? "Greenhouse" : "Farm and greenhouse",
  placeholder,
  houseExtra,
  className,
}: PlacePickerProps) {
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
  const single = farmNames.length === 1;
  const withHouses = level !== "farm";
  const showAll = level !== "greenhouse" && allLabel !== false && !single;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (showAll && !query.trim()) out.push({ id: "all", kind: "all" });
    for (const f of farmNames) {
      const houses = withHouses ? housesOf(farmMap, f).filter((h) => matchesQuery(`${f} ${h}`, query)) : [];
      if (!matchesQuery(f, query) && !houses.length) continue;
      out.push({ id: `f:${f}`, kind: "farm", farm: f, header: level === "greenhouse" });
      for (const h of houses) out.push({ id: `h:${h}`, kind: "house", farm: f, house: h });
    }
    return out;
  }, [farmMap, farmNames, query, showAll, withHouses, level]);

  const pickable = useMemo(() => rows.filter((r) => !(r.kind === "farm" && r.header)), [rows]);

  const houseFarm = value.greenhouse ? value.farm || farmOf(value.greenhouse, farmMap) : "";
  const selectedId = value.greenhouse
    ? `h:${value.greenhouse}`
    : value.farm
      ? `f:${value.farm}`
      : single && level !== "greenhouse"
        ? `f:${farmNames[0]}`
        : showAll
          ? "all"
          : null;

  const text = value.greenhouse
    ? houseLabel(value.greenhouse, houseFarm)
    : level === "greenhouse"
      ? placeholder ?? "Pick a greenhouse"
      : value.farm
        ? value.farm
        : single
          ? farmNames[0]
          : allLabel !== false
            ? allLabel
            : placeholder ?? "Pick a farm";

  // ── Remember and restore (G4) ────────────────────────────────────────────
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const restoredFor = useRef<string | null>(null);
  const ready = !disabled && farmNames.length > 0;

  useEffect(() => {
    if (!remember || !ready || restoredFor.current === crop) return;
    restoredFor.current = crop;
    const cur = latest.current.value;
    // A house the page already holds (a prefill, a deep link) wins.
    if (cur.greenhouse) return;
    const saved = readPlace(crop);
    if (!saved) return;
    const next = offered(saved);
    if (next && (next.farm !== cur.farm || next.greenhouse !== cur.greenhouse)) latest.current.onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remember, ready, crop]);

  /** The part of a remembered place this picker offers, or null. */
  function offered(saved: Place): Place | null {
    const farmOk = saved.farm && farmNames.includes(saved.farm);
    const houseOk =
      withHouses && saved.greenhouse && farmOk && housesOf(farmMap, saved.farm).includes(saved.greenhouse);
    if (level === "greenhouse") return houseOk ? saved : null;
    if (houseOk) return saved;
    if (farmOk) return { farm: saved.farm, greenhouse: "" };
    if (!saved.farm && !saved.greenhouse && showAll) return { farm: "", greenhouse: "" };
    return null;
  }

  function pick(row: Row) {
    if (row.kind === "farm" && row.header) return;
    const next: Place =
      row.kind === "all"
        ? { farm: "", greenhouse: "" }
        : row.kind === "farm"
          ? { farm: row.farm, greenhouse: "" }
          : { farm: row.farm, greenhouse: row.house };
    // Remembered only once the page has taken it (below): a page may refuse a
    // pick (e.g. "Discard unsaved changes?" answered No).
    pendingWrite.current = next;
    onChange(next);
    setOpen(false);
  }

  const pendingWrite = useRef<Place | null>(null);
  useEffect(() => {
    const next = pendingWrite.current;
    if (!next || !remember) return;
    const taken =
      level === "greenhouse"
        ? value.greenhouse === next.greenhouse
        : value.farm === next.farm && (level === "farm" || value.greenhouse === next.greenhouse);
    if (!taken) return;
    pendingWrite.current = null;
    // A farm-only page keeps the house remembered for that same farm.
    const saved = level === "farm" ? readPlace(crop) : null;
    writePlace(crop, saved && saved.farm === next.farm ? { ...next, greenhouse: saved.greenhouse } : next);
  }, [value.farm, value.greenhouse, remember, level, crop]);

  const onOpenChange = (o: boolean) => {
    setOpen(o);
    if (o) {
      setQuery("");
      setActive(selectedId);
    }
  };

  // Keep the active row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || !active) return;
    const el = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []).find(
      (n) => n.dataset.row === active,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const i = pickable.findIndex((r) => r.id === active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!pickable.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      const n = i < 0 ? (step > 0 ? 0 : pickable.length - 1) : (i + step + pickable.length) % pickable.length;
      setActive(pickable[n].id);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // With nothing highlighted, the best match: a farm row shown only as the
      // context of a matching house ("chep 16" → GH 16, not Chepsito) is skipped.
      const best = query.trim()
        ? pickable.find((r) => r.kind !== "farm" || matchesQuery(r.farm, query))
        : undefined;
      const row = pickable[i] ?? best ?? pickable[0];
      if (row) pick(row);
    }
  };

  const triggerClass = cn(
    "inline-flex min-w-0 items-center justify-between text-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
    variant === "field" ? FIELD_TRIGGER : cn("border", HEADER_PILL),
    className,
  );

  // A single farm with nothing beneath it to choose: the pill names the farm
  // and stays in place, so the header reads the same for every user (G5).
  if (single && level === "farm") {
    return (
      <div role="group" aria-label={label} title={farmNames[0]} className={cn(triggerClass, "cursor-default")}>
        <span className="truncate">{farmNames[0]}</span>
      </div>
    );
  }

  const listId = `${baseId}-list`;
  const optionId = (id: string) => `${baseId}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          title={value.greenhouse || undefined}
          disabled={disabled}
          className={triggerClass}
        >
          <span className={cn("truncate", level === "greenhouse" && !value.greenhouse && "text-muted-foreground")}>
            {text}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-2"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="relative mb-1.5">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            aria-label={`Search ${level === "farm" ? "farms" : "farms and greenhouses"}`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(null);
            }}
            onKeyDown={onKeyDown}
            placeholder={level === "farm" ? "Search farms" : "Search farm or greenhouse"}
            className="h-8 w-full rounded-full border border-input bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto">
          {rows.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">No match</div>
          )}
          {rows.map((r) => {
            if (r.kind === "farm" && r.header) {
              return (
                <div
                  key={r.id}
                  data-row={r.id}
                  role="presentation"
                  className="px-2 pb-0.5 pt-2 text-[11px] font-semibold text-muted-foreground"
                >
                  {r.farm}
                </div>
              );
            }
            const selected = r.id === selectedId;
            const rowText =
              r.kind === "all" ? (allLabel as string) : r.kind === "farm" ? r.farm : shortHouse(r.house, r.farm);
            return (
              <div
                key={r.id}
                id={optionId(r.id)}
                data-row={r.id}
                role="option"
                aria-selected={selected}
                title={r.kind === "house" ? r.house : undefined}
                onMouseMove={() => active !== r.id && setActive(r.id)}
                onClick={() => pick(r)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm",
                  r.kind === "house" ? "pl-6" : "pl-2",
                  r.kind === "farm" && "font-medium",
                  r.id === active && "bg-muted",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{rowText}</span>
                {r.kind === "house" && houseExtra?.(r.house)}
                <Check className={cn("h-3.5 w-3.5 shrink-0 text-primary", !selected && "invisible")} />
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
