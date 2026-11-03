/**
 * Multi-select for the pests and diseases a map shows — the PlacePicker's
 * sibling. One pill opens a searchable list: "Select all" on top, then the
 * "Pests" and "Diseases" groups as headers (each a tri-state select-all for its
 * group) with their items indented beneath, each with its colour dot, count
 * and a checkbox. The popover stays open while ticking.
 *
 * The pill reads "All pests and diseases", the single name, or "3 selected".
 * `value` holds the selected keys (`kind|name`); `onChange` gets the new set.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { SearchInput } from "@/components/SearchInput";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HEADER_PILL } from "@/components/header-controls";
import { useObservationColors } from "@/lib/observation-colors";
import { matchesQuery } from "@/lib/places";
import type { ObsOption } from "@/lib/pest-heat";
import { cn } from "@/lib/utils";

export const obsOptionKey = (o: { kind: string; name: string }) => `${o.kind}|${o.name}`;

type Row =
  | { id: string; kind: "all" }
  | { id: string; kind: "group"; group: "pest" | "disease"; keys: string[] }
  | { id: string; kind: "item"; opt: ObsOption };

const GROUPS: Array<{ kind: "pest" | "disease"; label: string }> = [
  { kind: "pest", label: "Pests" },
  { kind: "disease", label: "Diseases" },
];

export function pillText(options: ObsOption[], value: ReadonlySet<string>): string {
  const sel = options.filter((o) => value.has(obsOptionKey(o)));
  if (!options.length) return "No observations";
  if (!sel.length) return "None selected";
  if (sel.length === options.length) {
    const kinds = new Set(options.map((o) => o.kind));
    if (options.length === 1) return options[0].name;
    return kinds.size === 2 ? "All pests and diseases" : kinds.has("pest") ? "All pests" : "All diseases";
  }
  return sel.length === 1 ? sel[0].name : `${sel.length} selected`;
}

export function ObservationMultiPicker({
  options,
  value,
  onChange,
  className,
}: {
  options: ObsOption[];
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const { pest: pestColor, disease: diseaseColor } = useObservationColors();
  const colorOf = (o: ObsOption) => (o.kind === "pest" ? pestColor(o.name) : diseaseColor(o.name));

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (!query.trim() && options.length) out.push({ id: "all", kind: "all" });
    for (const g of GROUPS) {
      const items = options.filter((o) => o.kind === g.kind && matchesQuery(o.name, query));
      if (!items.length) continue;
      out.push({ id: `g:${g.kind}`, kind: "group", group: g.kind, keys: items.map(obsOptionKey) });
      for (const o of items) out.push({ id: `i:${obsOptionKey(o)}`, kind: "item", opt: o });
    }
    return out;
  }, [options, query]);

  const allKeys = useMemo(() => options.map(obsOptionKey), [options]);
  const stateOf = (keys: string[]): boolean | "indeterminate" => {
    const n = keys.filter((k) => value.has(k)).length;
    return n === 0 ? false : n === keys.length ? true : "indeterminate";
  };

  function toggleKeys(keys: string[]) {
    const next = new Set(value);
    const all = keys.every((k) => next.has(k));
    for (const k of keys) all ? next.delete(k) : next.add(k);
    onChange(next);
  }
  function toggle(row: Row) {
    if (row.kind === "all") toggleKeys(allKeys);
    else if (row.kind === "group") toggleKeys(row.keys);
    else toggleKeys([obsOptionKey(row.opt)]);
  }

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
      // Nothing highlighted while searching: Enter ticks the first match.
      const row = rows[i] ?? (query.trim() ? rows.find((r) => r.kind === "item") : undefined);
      if (row) toggle(row);
    }
  };

  const listId = `${baseId}-list`;
  const optionId = (id: string) => `${baseId}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const text = pillText(options, value);

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
          aria-label="Pests and diseases"
          aria-haspopup="listbox"
          disabled={!options.length}
          className={cn(
            "inline-flex min-w-0 max-w-[16rem] items-center justify-between border text-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
            HEADER_PILL,
            className,
          )}
        >
          <span className="truncate">{text}</span>
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
          aria-label="Search pests and diseases"
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(null);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search pests and diseases"
          className="mb-1.5"
        />
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Pests and diseases"
          className="max-h-72 overflow-y-auto"
        >
          {rows.length === 0 && <div className="px-2 py-3 text-center text-xs text-muted-foreground">No match</div>}
          {rows.map((r) => {
            const checked =
              r.kind === "all" ? stateOf(allKeys) : r.kind === "group" ? stateOf(r.keys) : value.has(obsOptionKey(r.opt));
            const name =
              r.kind === "all"
                ? "Select all"
                : r.kind === "group"
                  ? GROUPS.find((g) => g.kind === r.group)!.label
                  : r.opt.name;
            return (
              <div
                key={r.id}
                id={optionId(r.id)}
                data-row={r.id}
                role="option"
                aria-selected={checked === true}
                aria-checked={checked === "indeterminate" ? "mixed" : checked}
                aria-label={r.kind === "group" ? `${name}, select all` : name}
                onMouseMove={() => active !== r.id && setActive(r.id)}
                onClick={() => toggle(r)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm",
                  r.kind === "item" ? "pl-6" : "pl-2 font-medium",
                  r.kind === "group" && "text-[11px] font-semibold text-muted-foreground",
                  r.id === active && "bg-muted",
                )}
              >
                <Checkbox
                  checked={checked}
                  tabIndex={-1}
                  aria-hidden
                  className="pointer-events-none"
                />
                {r.kind === "item" && (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full border"
                    style={{ background: colorOf(r.opt) }}
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {r.kind === "item" && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.opt.count}</span>
                )}
                {r.kind === "group" && (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {r.keys.filter((k) => value.has(k)).length}/{r.keys.length}
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
