/**
 * Searchable single-choice picker: a trigger like the Select's, and a popover with a
 * text box that filters the options by every word typed (not Radix Select's
 * one-letter type-ahead). Popover + Input + buttons, like BomPicker.
 */
import { useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface SearchOption {
  value: string;
  label: string;
  hint?: string;
}

export function filterOptions(options: SearchOption[], query: string): SearchOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const hay = `${o.label} ${o.hint ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder = "None",
  noneLabel = "None",
  disabled,
  className = "",
  ariaLabel,
}: {
  value: string | null;
  options: SearchOption[];
  onChange: (v: string | null) => void;
  placeholder?: string;
  noneLabel?: string | null;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterOptions(options, query).slice(0, 200), [options, query]);
  const current = options.find((o) => o.value === value);
  const pick = (v: string | null) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          className={`flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-xs disabled:opacity-50 ${className}`}
        >
          <span className={`truncate ${current ? "" : "text-muted-foreground"}`}>{current?.label ?? placeholder}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="z-[1000] w-[var(--radix-popover-trigger-width)] min-w-64 p-2">
        <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type to search…" className="mb-2 h-8 text-xs" />
        <div className="max-h-64 overflow-auto" role="listbox">
          {noneLabel !== null && !query && (
            <button type="button" onClick={() => pick(null)} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted">
              {noneLabel}
              {value == null && <Check className="h-3 w-3" />}
            </button>
          )}
          {shown.map((o) => (
            <button key={o.value} type="button" role="option" aria-selected={o.value === value} onClick={() => pick(o.value)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted">
              <span className="truncate">
                {o.label}
                {o.hint ? <span className="ml-1 text-muted-foreground">({o.hint})</span> : null}
              </span>
              {o.value === value && <Check className="h-3 w-3 shrink-0" />}
            </button>
          ))}
          {!shown.length && <div className="px-2 py-1.5 text-xs text-muted-foreground">No match.</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
