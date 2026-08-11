/**
 * Searchable BOM picker — a drop-in replacement for the plain <Select> the
 * Application Plan used to render its Chemical Mix BOMs into.
 *
 * The site carries ~2,400 active Chemical Mix BOMs and `bootstrap.tank_mixes`
 * ships all of them, so the old Select mounted thousands of options at once and
 * the only way to reach one was scrolling. This filters client-side (the data is
 * already loaded — no round-trip) and renders at most MAX_RENDERED_BOMS rows.
 *
 * Deliberately built from Popover + Input + a list of buttons rather than a new
 * command/combobox primitive, so it matches the Add-chemical dialog already on
 * this page.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface BomOption {
  name: string;
  item_name?: string | null;
  /** Added behind a `has_column` guard server-side, so treat it as optional. */
  custom_farm?: string | null;
}

/** Ceiling on rows rendered at once. The cap — not the filtering — is what
 *  keeps the list responsive on the full ~2,400-BOM set. */
export const MAX_RENDERED_BOMS = 50;

const norm = (v?: string | null) => (v || "").toLowerCase();

/**
 * Filter `boms` by a free-text query across mix name, BOM name and farm.
 *
 * Returns the rows to render (`shown`, capped at `limit`) alongside the full
 * match count (`matched`) so the caller can tell the operator when results were
 * truncated. Pure — unit-tested in __tests__/BomPicker.test.ts.
 */
export function filterBoms(
  boms: BomOption[],
  query: string,
  limit: number = MAX_RENDERED_BOMS,
): { shown: BomOption[]; matched: number } {
  const q = (query || "").trim().toLowerCase();
  const matches = q
    ? boms.filter(
        (b) =>
          norm(b.item_name).includes(q) ||
          norm(b.name).includes(q) ||
          norm(b.custom_farm).includes(q),
      )
    : boms;
  return { shown: matches.slice(0, limit), matched: matches.length };
}

/** Trigger label for a BOM: the mix name, falling back to the BOM code, with
 *  the farm appended when known. Mirrors the old SelectItem's label. */
function labelFor(bom: BomOption): string {
  const base = bom.item_name || bom.name;
  return bom.custom_farm ? `${base} · ${bom.custom_farm}` : base;
}

export interface BomPickerProps {
  boms: BomOption[];
  value: string;
  onValueChange: (name: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

export function BomPicker({
  boms,
  value,
  onValueChange,
  placeholder = "Select BOM",
  className,
  disabled,
}: BomPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { shown, matched } = useMemo(
    () => filterBoms(boms, query),
    [boms, query],
  );

  const selected = useMemo(
    () => boms.find((b) => b.name === value),
    [boms, value],
  );

  // Reset the query and the highlight every time the popover opens, so a stale
  // search from a previous pick doesn't hide the list.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // Keep the highlight in range as the query narrows the list.
  useEffect(() => {
    setActive((a) => (a >= shown.length ? 0 : a));
  }, [shown.length]);

  // Scroll the highlighted row into view for keyboard navigation. Optional call
  // because scrollIntoView is absent in jsdom and on older browsers — losing the
  // scroll is fine, throwing mid-render is not.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`,
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const pick = (bom: BomOption) => {
    onValueChange(bom.name);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const bom = shown[active];
      if (bom) pick(bom);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span
            className={cn(
              "truncate text-left",
              !selected && "text-muted-foreground",
            )}
          >
            {selected ? labelFor(selected) : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 text-[var(--sd-quiet)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(28rem,var(--radix-popover-trigger-width))] p-0"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by mix, BOM code or farm…"
            autoFocus
            className="h-7 border-0 p-0 text-xs shadow-none focus-visible:ring-0"
          />
        </div>

        <div ref={listRef} className="max-h-72 overflow-auto p-1">
          {shown.map((b, i) => (
            <button
              key={b.name}
              type="button"
              data-idx={i}
              onClick={() => pick(b)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                i === active && "bg-muted",
              )}
            >
              <Check
                className={cn(
                  "mt-[2px] h-3.5 w-3.5 shrink-0",
                  b.name === value ? "opacity-100" : "opacity-0",
                )}
              />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">
                  {b.item_name || b.name}
                </span>
                <span className="block truncate font-mono text-[0.65rem] text-muted-foreground">
                  {b.name}
                  {b.custom_farm ? ` · ${b.custom_farm}` : ""}
                </span>
              </span>
            </button>
          ))}

          {!shown.length && (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">
              {query.trim()
                ? `No BOM matches “${query.trim()}”.`
                : "No BOMs available."}
            </div>
          )}
        </div>

        {matched > shown.length && (
          <div className="border-t px-3 py-1.5 text-[0.65rem] text-muted-foreground">
            {matched.toLocaleString()} matches · showing {shown.length} — refine
            your search
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
